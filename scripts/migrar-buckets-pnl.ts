// ─────────────────────────────────────────────────────────────────────────────
// MIGRACIÓN DE DATOS — los resultados del grupo PnL se mudan a su bucket propio
//
//   npx tsx scripts/migrar-buckets-pnl.ts              → DRY-RUN (no toca nada)
//   npx tsx scripts/migrar-buckets-pnl.ts --aplicar    → escribe
//   npx tsx scripts/migrar-buckets-pnl.ts --company=<uuid>
//
// ── EL PORQUÉ (medido el 2026-09-16) ───────────────────────────────────────
// Hector Gamboa (grupo PnL) mostraba TOTAL **$319,77** en el tab del mes y
// **$740,61** en el tab Historial, para el MISMO agosto. Tenía TRES filas de
// agosto en `commercial_monthly_results` bajo tres `head_id` distintos: dos
// copias con el manual vigente (319,77) y una vieja con el CRM automático de
// antes (740,61). Cada pantalla pescaba una fila distinta — la violación exacta
// del invariante A3 (§2.1): *un mismo número tiene que salir del mismo camino*.
// Ninguna de las dos lanzó jamás una excepción (§1.2).
//
// El barrido a todos los perfiles PnL mostró el desastre general: filas de la
// misma persona y el mismo mes bajo los buckets de Hugo Ortiz, Luka, Ana,
// Nicolas Garzaro y «propio», guardadas en distintas épocas con distinta lógica
// de bucket (`r.head_id ?? profile.head_id ?? profile.id` heredaba el bucket de
// la fila vieja que encontrara). Hay meses cuya ÚNICA fila vive bajo un bucket
// ajeno (Millones693 en enero, febrero y mayo), así que esto NO se puede
// resolver borrando lo que no es propio: hay que MUDARLO.
//
// El código ya está arreglado (escribe y lee siempre el bucket propio, y limpia
// al guardar). Este script arregla lo que quedó ESCRITO. Son dos cosas
// separadas a propósito: una empresa que no lo corra sigue funcionando gracias
// al fallback documentado de lectura en src/lib/hr/pnl-buckets.ts.
//
// ── LA EXCEPCIÓN QUE NO SE ROMPE ───────────────────────────────────────────
// Jose Emanuel (PnL Especial) es además MASTER IB colgado de Ana García. Su
// fila bajo el bucket de Ana (agosto: TOTAL −110.151,25, net_deposit_current
// 284.557,45) NO es un duplicado del PnL: es su LÍNEA DE NET DEPOSIT del grupo
// de Ana. Queda fuera de todo — ni se migra, ni se borra, ni se cuenta. La
// excepción se aplica en `filasPnlDe` / `planDeBucketPnl`, no acá.
//
// ── LA ARITMÉTICA PELIGROSA VIVE EN UN MÓDULO CON TESTS ────────────────────
// Elegir qué fila sobrevive es lo único de acá que puede pagar mal, así que no
// está en este archivo: está en `planDeBucketPnl` (src/lib/hr/pnl-buckets.ts)
// con su test, incluido el caso Hector. Este script solo ejecuta el plan.
//
// ── EL UNIQUE ──────────────────────────────────────────────────────────────
// Producción tiene un UNIQUE que incluye `head_id` (reportado como A5: no hay
// migración en el repo que lo cree). Por eso, cuando ya existe una fila propia
// y el superviviente es OTRA, no se re-homea: se copian los valores del
// superviviente SOBRE la fila propia y se borra el superviviente. Un UPDATE de
// `head_id` ahí chocaría contra el índice.
//
// ── LO QUE SE DESCARTÓ ─────────────────────────────────────────────────────
// · Hacerlo en SQL: la elección del superviviente quedaría duplicada (§1.1) y
//   sin test. La fórmula vive en TypeScript y se llama desde acá.
// · Borrar todo lo que no sea el bucket propio: se perderían los meses cuya
//   única fila es ajena (Millones693).
// · Quedarse con la de mayor `total_earned`: paga de más por construcción.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';
import {
  bucketDePnl,
  filasPnlDe,
  planDeBucketPnl,
  type FilaMigrable,
  type PerfilPnl,
} from '../src/lib/hr/pnl-buckets';

config({ path: '.env.local' });

/** Vex Pro. Parametrizable con `--company=<uuid>` para el resto de tenants. */
const COMPANY_POR_DEFECTO = '71715987-5479-52c4-a990-c414fb3a9b36';

const argv = process.argv.slice(2);
const APLICAR = argv.includes('--aplicar');
const COMPANY_ID = (argv.find((a) => a.startsWith('--company='))?.split('=')[1] ?? COMPANY_POR_DEFECTO).trim();

/** Las columnas de dinero que se copian de un superviviente a la fila propia. */
const COLUMNAS_DE_VALOR = [
  'net_deposit_current',
  'net_deposit_accumulated',
  'net_deposit_total',
  'pnl_current',
  'pnl_accumulated',
  'pnl_total',
  'division',
  'base_amount',
  'commissions_earned',
  'real_payment',
  'accumulated_out',
  'salary_paid',
  'total_earned',
  'bonus',
  'pct_override',
] as const;

type FilaDb = FilaMigrable & {
  id: string;
  period_id: string;
  total_earned: number | null;
  [k: string]: unknown;
};

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Faltan NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env.local');
  process.exit(1);
}
const db = createClient(url, key);

const money = (v: unknown) =>
  v === null || v === undefined ? '—' : Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  console.log('═'.repeat(78));
  console.log(`MIGRACIÓN DE BUCKETS PnL — empresa ${COMPANY_ID}`);
  console.log(APLICAR ? '*** MODO --aplicar: SE VA A ESCRIBIR EN LA BASE ***' : 'DRY-RUN (no se escribe nada). Agregá --aplicar para ejecutar.');
  console.log('═'.repeat(78));

  // 1. Los perfiles del grupo PnL de la empresa.
  const { data: perfiles, error: errPerfiles } = await db
    .from('commercial_profiles')
    .select('id, name, email, head_id, is_master_ib, pnl_pct')
    .eq('company_id', COMPANY_ID)
    .not('pnl_pct', 'is', null)
    .order('name');
  if (errPerfiles) throw errPerfiles;
  if (!perfiles?.length) {
    console.log('No hay perfiles con pnl_pct en esta empresa. Nada que hacer.');
    return;
  }
  console.log(`Perfiles de PnL: ${perfiles.length}\n`);

  // 2. Los períodos, para poder rotular los meses en el plan.
  const { data: periodos, error: errPeriodos } = await db
    .from('periods')
    .select('id, year, month, label, is_closed')
    .eq('company_id', COMPANY_ID);
  if (errPeriodos) throw errPeriodos;
  const rotulo = new Map<string, string>();
  const orden = new Map<string, number>();
  for (const p of periodos ?? []) {
    rotulo.set(p.id, p.label || `${p.year}-${String(p.month).padStart(2, '0')}`);
    orden.set(p.id, p.year * 100 + p.month);
  }

  let perfilesTocados = 0;
  let periodosTocados = 0;
  let rehomeadas = 0;
  let copiadas = 0;
  let borradas = 0;
  let yaOk = 0;
  let lineasNdDeMaster = 0;
  const avisos: string[] = [];
  const errores: string[] = [];

  for (const perfil of perfiles) {
    const profile: PerfilPnl = {
      id: perfil.id,
      head_id: perfil.head_id,
      is_master_ib: perfil.is_master_ib,
    };

    // 3. TODAS sus filas, de todos los períodos. `updated_at` es la clave de la
    //    decisión: es lo último que alguien guardó = lo que muestra el tab del mes.
    const { data: filas, error: errFilas } = await db
      .from('commercial_monthly_results')
      .select(`id, profile_id, period_id, head_id, updated_at, ${COLUMNAS_DE_VALOR.join(', ')}`)
      .eq('company_id', COMPANY_ID)
      .eq('profile_id', perfil.id);
    if (errFilas) throw errFilas;
    const todas = (filas ?? []) as unknown as FilaDb[];
    if (todas.length === 0) continue;

    // La línea ND del master se cuenta para poder decir que se respetó (§1.2:
    // una exclusión silenciosa es indistinguible de un cruce roto).
    lineasNdDeMaster += todas.length - filasPnlDe(todas, profile).length;

    const porPeriodo = new Map<string, FilaDb[]>();
    for (const f of todas) {
      const arr = porPeriodo.get(f.period_id);
      if (arr) arr.push(f); else porPeriodo.set(f.period_id, [f]);
    }

    const periodosOrdenados = [...porPeriodo.keys()].sort(
      (a, b) => (orden.get(a) ?? 0) - (orden.get(b) ?? 0),
    );

    let encabezadoImpreso = false;
    for (const periodId of periodosOrdenados) {
      const delMes = porPeriodo.get(periodId)!;
      const plan = planDeBucketPnl(delMes, profile);
      if (plan.sinCambios) {
        if (plan.motivo === 'ya-propia') yaOk += 1;
        continue;
      }
      if (!encabezadoImpreso) {
        console.log(`── ${perfil.name} <${perfil.email}>${perfil.is_master_ib ? '  [MASTER IB]' : ''}`);
        encabezadoImpreso = true;
        perfilesTocados += 1;
      }
      periodosTocados += 1;

      const mes = rotulo.get(periodId) ?? periodId;
      const queda = plan.queda as FilaDb;
      const superviviente = plan.superviviente as FilaDb;
      const accion = plan.necesitaRehome
        ? `RE-HOMEAR (head_id ${queda.head_id ?? 'null'} → ${bucketDePnl(profile)})`
        : plan.necesitaCopia
          ? `COPIAR valores del superviviente SOBRE la fila propia y borrarlo`
          : 'la fila propia ya es la buena';
      console.log(`   ${mes}  ${accion}   [motivo: ${plan.motivo}]`);
      console.log(
        `      queda    id=${queda.id} head=${queda.head_id ?? 'null'} TOTAL=${money(queda.total_earned)} upd=${queda.updated_at ?? '—'}`,
      );
      if (plan.necesitaCopia) {
        console.log(
          `      valores  id=${superviviente.id} head=${superviviente.head_id ?? 'null'} TOTAL=${money(superviviente.total_earned)} upd=${superviviente.updated_at ?? '—'}`,
        );
      }
      for (const f of plan.aBorrar as FilaDb[]) {
        console.log(
          `      BORRAR   id=${f.id} head=${f.head_id ?? 'null'} TOTAL=${money(f.total_earned)} upd=${f.updated_at ?? '—'}`,
        );
      }
      if (plan.advertencia) {
        const aviso = `${perfil.name} · ${mes}: ${plan.advertencia}`;
        console.log(`      ⚠ ${aviso}`);
        avisos.push(aviso);
      }

      if (!APLICAR) {
        if (plan.necesitaRehome) rehomeadas += 1;
        if (plan.necesitaCopia) copiadas += 1;
        borradas += plan.aBorrar.length;
        continue;
      }

      // 4. Escribir. Primero la fila que queda (así nunca hay un instante sin
      //    ninguna fila), después los borrados.
      try {
        if (plan.necesitaRehome) {
          const { error } = await db
            .from('commercial_monthly_results')
            .update({ head_id: bucketDePnl(profile) })
            .eq('id', queda.id)
            .eq('company_id', COMPANY_ID); // defensa en profundidad: RLS no aplica con service role
          if (error) throw error;
          rehomeadas += 1;
        } else if (plan.necesitaCopia) {
          const valores: Record<string, unknown> = {};
          for (const c of COLUMNAS_DE_VALOR) valores[c] = superviviente[c];
          const { error } = await db
            .from('commercial_monthly_results')
            .update(valores)
            .eq('id', queda.id)
            .eq('company_id', COMPANY_ID);
          if (error) throw error;
          copiadas += 1;
        }

        if (plan.aBorrar.length > 0) {
          const ids = (plan.aBorrar as FilaDb[]).map((f) => f.id);
          const { error } = await db
            .from('commercial_monthly_results')
            .delete()
            .eq('company_id', COMPANY_ID)
            .in('id', ids);
          if (error) throw error;
          borradas += ids.length;
        }
      } catch (e) {
        const msg = `${perfil.name} · ${mes}: ${e instanceof Error ? e.message : String(e)}`;
        console.log(`      ✖ ERROR: ${msg}`);
        errores.push(msg);
      }
    }
    if (encabezadoImpreso) console.log('');
  }

  console.log('═'.repeat(78));
  console.log(APLICAR ? 'RESULTADO' : 'PLAN (dry-run — no se escribió nada)');
  console.log(`  perfiles con algo que migrar ....... ${perfilesTocados}`);
  console.log(`  (perfil, período) tocados .......... ${periodosTocados}`);
  console.log(`  filas re-homeadas al bucket propio . ${rehomeadas}`);
  console.log(`  filas propias pisadas con el nuevo . ${copiadas}`);
  console.log(`  filas borradas ..................... ${borradas}`);
  console.log(`  (perfil, período) ya correctos ..... ${yaOk}`);
  console.log(`  líneas ND de MASTER IB respetadas .. ${lineasNdDeMaster}`);
  console.log(`  avisos (elección no obvia) ......... ${avisos.length}`);
  console.log(`  errores ............................ ${errores.length}`);
  for (const a of avisos) console.log(`    ⚠ ${a}`);
  for (const e of errores) console.log(`    ✖ ${e}`);
  console.log('═'.repeat(78));
  if (!APLICAR) console.log('Revisá el plan y volvé a correr con --aplicar para ejecutarlo.');
  if (errores.length > 0) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error('ERROR:', e?.message ?? e);
    process.exit(1);
  });
