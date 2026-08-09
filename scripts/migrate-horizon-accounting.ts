// ─────────────────────────────────────────────────────────────────────────────
// Migración de la contabilidad de Horizon (Google Sheets → dashboard).
//
//   npx tsx scripts/migrate-horizon-accounting.ts <horizon.json> [--apply]
//
// Sin --apply hace un ENSAYO: lee, valida, muestra qué escribiría y no toca
// nada. Es la forma de mirar el resultado antes de comprometerlo.
//
// IDEMPOTENTE: cada período se reemplaza entero (replace_income_lines y
// replace_period_expenses borran e insertan). Correrlo dos veces deja el mismo
// estado, no el doble.
//
// DECISIONES TOMADAS CON KEVIN (2026-08-09)
//   · Los meses anteriores se migran TAL CUAL están en la planilla, con sus
//     inconsistencias. No se recalcula nada hacia atrás: la historia es la que
//     es, y "arreglarla" ahora sería inventar números que nadie firmó.
//   · El respaldo financiero acumulado arranca de CERO en el mes actual. El
//     fondo se consumió; los $50.344 de diferencia contra los aportes
//     declarados quedan fuera del dashboard a propósito.
//   · La reserva de cada mes se carga con el % que la planilla usó ESE mes
//     (15% habitual, 50% en Oct 25, ~12% en Mar/Abr 26, 0% en Jul/Ago 26).
//
// POR QUÉ LOS INGRESOS VAN COMO LÍNEAS Y NO COMO UN NÚMERO
// operating_income guarda tres totales por período. La planilla lleva de 3 a
// 12 facturas mensuales con cliente y estado de cobro: volcarlas a un total
// tiraría los $40.136 por cobrar y el detalle de quién los debe. Por eso
// primero se construyó income_lines (migración 068) y recién después esto.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve } from 'path';

for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

interface SheetMonth {
  mes: string;
  ing: Array<[string, number, number | null, number | null]>;
  egr: Array<[string, number, number | null, number | null]>;
  bruto?: number;
  reserva?: number;
  neto?: number;
  tot_egr?: number;
}

/** "Sep 25" → { year, month }. La planilla usa abreviaturas en español. */
const MONTHS: Record<string, number> = {
  Ene: 1, Feb: 2, Mar: 3, Abr: 4, May: 5, Jun: 6,
  Jul: 7, Ago: 8, Sep: 9, Oct: 10, Nov: 11, Dic: 12,
};

function parseLabel(label: string): { year: number; month: number } {
  const [name, yy] = label.split(' ');
  const month = MONTHS[name];
  if (!month) throw new Error(`Mes desconocido: ${label}`);
  return { year: 2000 + Number(yy), month };
}

/**
 * Clientes reconocidos en los conceptos. La planilla mezcla cliente y servicio
 * en un solo texto ("Vex Pro CRM", "Be Prime Trafficker"), así que el cliente
 * se deduce por prefijo — el concepto se conserva intacto.
 */
const CLIENTS = [
  'Vex Pro', 'Vex B2Prime', 'VEX Pro', 'Vex Group', 'Vex',
  'Be Prime', 'Exura', 'Bullfy', 'AP Markets', 'BitGain', 'White Kapital',
];

function guessClient(concept: string): string | null {
  const c = concept.toLowerCase();
  for (const name of CLIENTS) {
    if (c.startsWith(name.toLowerCase())) return name;
  }
  for (const name of CLIENTS) {
    if (c.includes(name.toLowerCase())) return name;
  }
  return null;
}

async function main() {
  const file = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!file) {
    console.error('Uso: npx tsx scripts/migrate-horizon-accounting.ts <horizon.json> [--apply]');
    process.exit(1);
  }

  const months = JSON.parse(readFileSync(file, 'utf8')) as SheetMonth[];
  const { createAdminClient } = await import('@/lib/supabase/admin');
  const admin = createAdminClient();

  const { data: company } = await admin
    .from('companies')
    .select('id, name')
    .ilike('name', '%horizon%')
    .maybeSingle();
  if (!company) throw new Error('No se encontró la empresa Horizon');
  console.log(`Empresa: ${company.name} (${company.id})`);
  console.log(apply ? '\n*** APLICANDO CAMBIOS ***\n' : '\n--- ENSAYO (sin --apply no se escribe nada) ---\n');

  // Socios: la planilla reparte 50/50 entre Kevin y Stiven en los 12 meses.
  // Sin ellos la cadena de distribución no tiene a quién repartirle y /socios
  // avisa que falta asignar el 100%.
  const PARTNERS = [
    { name: 'Kevin', percentage: 0.5 },
    { name: 'Stiven', percentage: 0.5 },
  ];
  const { data: existingPartners } = await admin
    .from('partners').select('name').eq('company_id', company.id);
  const haveNames = new Set((existingPartners ?? []).map((p: { name: string }) => p.name.toLowerCase()));
  const missing = PARTNERS.filter((p) => !haveNames.has(p.name.toLowerCase()));
  if (missing.length) {
    console.log(`Socios a crear: ${missing.map((p) => `${p.name} ${p.percentage * 100}%`).join(', ')}`);
    if (apply) {
      const { error } = await admin.from('partners')
        .insert(missing.map((p) => ({ company_id: company.id, ...p })));
      if (error) throw new Error(`Socios: ${error.message}`);
    }
  } else {
    console.log('Socios: ya estaban cargados');
  }

  let totalIncome = 0, totalExpenses = 0, totalPendingIn = 0, totalPendingOut = 0;

  for (const m of months) {
    const { year, month } = parseLabel(m.mes);

    // El período puede existir (los crea el cron) o no.
    let { data: period } = await admin
      .from('periods')
      .select('id, label, is_closed')
      .eq('company_id', company.id)
      .eq('year', year)
      .eq('month', month)
      .maybeSingle();

    const reservePct = m.bruto && m.reserva ? Number((m.reserva / m.bruto).toFixed(4)) : 0;

    if (!period) {
      if (apply) {
        const { data, error } = await admin
          .from('periods')
          .insert({
            company_id: company.id, year, month, label: m.mes,
            is_closed: false, reserve_pct: reservePct,
          })
          .select('id, label, is_closed')
          .single();
        if (error) throw new Error(`Alta de período ${m.mes}: ${error.message}`);
        period = data;
      } else {
        period = { id: '(nuevo)', label: m.mes, is_closed: false };
      }
    } else if (apply) {
      await admin.from('periods')
        .update({ reserve_pct: reservePct })
        .eq('id', period.id).eq('company_id', company.id);
    }

    const incomeLines = m.ing
      .filter(([concept, amount]) => concept.trim() && (amount || 0) !== 0)
      .map(([concept, amount, received, pending], i) => ({
        concept: concept.trim(),
        client: guessClient(concept),
        amount,
        received: received ?? 0,
        pending: pending ?? Math.max(0, amount - (received ?? 0)),
        sort_order: i,
      }));

    const expenseLines = m.egr
      .filter(([concept, amount]) => concept.trim() && (amount || 0) !== 0)
      .map(([concept, amount, paid, pending], i) => ({
        concept: concept.trim(),
        amount,
        paid: paid ?? 0,
        pending: pending ?? Math.max(0, amount - (paid ?? 0)),
        sort_order: i,
      }));

    const inTot = incomeLines.reduce((s, l) => s + l.amount, 0);
    const inRec = incomeLines.reduce((s, l) => s + l.received, 0);
    const exTot = expenseLines.reduce((s, l) => s + l.amount, 0);
    const exPend = expenseLines.reduce((s, l) => s + l.pending, 0);
    totalIncome += inTot; totalExpenses += exTot;
    totalPendingIn += inTot - inRec; totalPendingOut += exPend;

    console.log(
      `${m.mes.padEnd(7)} reserva ${(reservePct * 100).toFixed(1).padStart(5)}%  ` +
      `ingresos ${incomeLines.length.toString().padStart(2)} (${inTot.toLocaleString('es')} fact / ${inRec.toLocaleString('es')} cobr)  ` +
      `egresos ${expenseLines.length.toString().padStart(2)} (${exTot.toLocaleString('es')})`,
    );

    if (!apply) continue;

    const { error: incErr } = await admin.rpc('replace_income_lines', {
      p_company_id: company.id, p_period_id: period.id, p_lines: incomeLines,
    });
    if (incErr) throw new Error(`Ingresos ${m.mes}: ${incErr.message}`);

    const { error: expErr } = await admin.rpc('replace_period_expenses', {
      p_company_id: company.id, p_period_id: period.id, p_rows: expenseLines,
    });
    if (expErr) throw new Error(`Egresos ${m.mes}: ${expErr.message}`);
  }

  console.log(
    `\nTOTALES  facturado ${totalIncome.toLocaleString('es')}  ` +
    `por cobrar ${totalPendingIn.toLocaleString('es')}  ` +
    `egresos ${totalExpenses.toLocaleString('es')}  ` +
    `por pagar ${totalPendingOut.toLocaleString('es')}`,
  );
  if (!apply) console.log('\nEnsayo terminado. Volvé a correrlo con --apply para escribir.');
}

main().catch((e) => { console.error(e); process.exit(1); });
