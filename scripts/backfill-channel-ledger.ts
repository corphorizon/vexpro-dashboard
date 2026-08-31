// ─────────────────────────────────────────────────────────────────────────────
// Backfill del libro de un canal automático desde los snapshots ya guardados.
//
//   npx tsx scripts/backfill-channel-ledger.ts <canal> --company "<nombre>"
//   npx tsx scripts/backfill-channel-ledger.ts <canal> --company "<nombre>" --apply
//
// POR QUÉ EXISTE (2026-08-31)
// FairPay entró a `API_LEDGER_CHANNELS` con tres semanas de snapshots diarios
// ya escritos y un libro que solo tenía la apertura de $0,00 del 2026-08-05.
// El cron de las 00:00 UTC asienta UN día por corrida: sin backfill, la
// pantalla habría seguido mostrando $0,00 hasta que pasaran tantas noches como
// días de historia. Y el libro le gana al snapshot, así que "esperar" no era
// una opción: era seguir mostrando un cero falso.
//
// CÓMO FUNCIONA
// Replica exactamente lo que hace el cron, día por día y en orden cronológico:
// llama a `syncChannelLedgerDay` con el saldo real de cada snapshot. No hay
// una segunda fórmula — es la misma función, que es todo el punto (§1.1 de
// docs/reglas-del-proyecto.md: nunca una segunda lista, nunca un segundo
// cálculo).
//
// EL DESFASE DE UN DÍA NO ES UN DETALLE
// El snapshot con `snapshot_date = D` es el CIERRE de D−1 (lo escribe el cron a
// las 00:00 UTC de D). Por eso el asiento va fechado `previousDay(D)`, igual
// que en el cron. Fecharlo en D correría el libro entero un día y "saldo al 25
// de agosto" mostraría cómo cerró el 24.
//
// SECUENCIAL A PROPÓSITO: cada día se apoya en el saldo del anterior. Correrlo
// en paralelo daría ajustes calculados contra un saldo previo que todavía no
// existe. Es la misma razón por la que la cadena de distribución procesa los
// períodos en orden (§2.2).
//
// IDEMPOTENTE: `replace_channel_ledger_day` reemplaza las líneas `source='api'`
// del día, así que volver a correrlo no duplica nada. Las líneas MANUALES no
// se tocan nunca, ni acá ni en el cron.
//
// ARRANQUE: por defecto empieza en el día siguiente al último asiento que ya
// tenga el libro, para no pisar historia ni chocar con la apertura existente.
// Con --from YYYY-MM-DD se fuerza otro arranque (reproceso de un tramo).
//
// ── REPROCESO PENDIENTE: COINSBUY 21/08 → 31/08 (2026-08-31) ────────────────
// El guard de `MAX_ADJUSTMENT.coinsbuy` (500, escrito cuando el canal tenía UNA
// wallet y comisiones de red de $1-4/día) abortó el asiento del 21/08 porque el
// ajuste real era −8.478,29. Como abortar no deja estado, cada noche siguiente
// comparó contra el saldo del 20/08 y volvió a superar el tope: el libro quedó
// congelado en 244.079,51 contra 335.835,65 reales — $91.756,14 de brecha, 11
// avisos `ledger.not_posted` y cero recuperación.
//
// El tope ya está recalibrado (150.000, con la medición en channel-ledger-sync.ts)
// y el guard ya no congela para siempre, pero eso solo arregla de acá en
// adelante: los diez días perdidos hay que asentarlos. Este script los
// reconstruye UNO POR UNO contra el snapshot real de cada fecha, que es la
// forma correcta — mejor que la línea automática de regularización, que
// acumularía los diez días en un solo importe sin desglose.
//
//   npx tsx scripts/backfill-channel-ledger.ts coinsbuy --company "Vex Pro" --from 2026-08-21
//   npx tsx scripts/backfill-channel-ledger.ts coinsbuy --company "Vex Pro" --from 2026-08-21 --apply
//
// Correr SIEMPRE primero sin --apply y leer la lista de días y cierres. Al
// terminar, el saldo del libro tiene que dar 335.835,65 (o el cierre del último
// snapshot disponible ese día). Es idempotente: si algo sale raro, se corrige
// la causa y se vuelve a correr el mismo tramo.
//
// ⚠ NO borra ni toca el asiento MANUAL de +38.397,58 del 2026-08-06 (el alta de
// la wallet 1705), que se coló antes de que existiera la validación de canal
// automático. `syncChannelLedgerDay` lo SUMA como parte del saldo del día, así
// que el reproceso cierra bien con él adentro. Sacarlo es una decisión aparte
// y exigiría reprocesar desde el 06/08.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'fs';
import { resolve } from 'path';

for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

/** Canales sin extracto: el día se asienta como «Variación del saldo». */
const NO_MOVEMENT_FEED = new Set(['fairpay']);

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const channelKey = process.argv[2];
  const companyName = arg('company');
  const fromArg = arg('from');
  const apply = process.argv.includes('--apply');

  if (!channelKey || !companyName) {
    console.error(
      'Uso: npx tsx scripts/backfill-channel-ledger.ts <canal> --company "<nombre>" [--from YYYY-MM-DD] [--apply]',
    );
    process.exit(1);
  }

  const { createAdminClient } = await import('@/lib/supabase/admin');
  const { syncChannelLedgerDay } = await import('@/lib/channel-ledger-sync');
  const { previousDay } = await import('@/lib/channel-ledger');
  const admin = createAdminClient();

  const { data: company, error: companyErr } = await admin
    .from('companies')
    .select('id, name')
    .eq('name', companyName)
    .single();
  if (companyErr || !company) throw new Error(`Empresa "${companyName}" no encontrada`);

  // Último día ya asentado: el backfill arranca DESPUÉS, salvo --from.
  const { data: lastEntry } = await admin
    .from('channel_ledger_entries')
    .select('entry_date')
    .eq('company_id', company.id)
    .eq('channel_key', channelKey)
    .order('entry_date', { ascending: false })
    .limit(1)
    .maybeSingle<{ entry_date: string }>();

  const startEntryDate = fromArg ?? (lastEntry ? nextDay(lastEntry.entry_date) : null);

  const { data: snapshots, error: snapErr } = await admin
    .from('channel_balances')
    .select('snapshot_date, amount, source')
    .eq('company_id', company.id)
    .eq('channel_key', channelKey)
    .order('snapshot_date', { ascending: true });
  if (snapErr) throw new Error(`channel_balances: ${snapErr.message}`);

  // Un snapshot con fecha D es el cierre de D−1 (ver cabecera).
  const days = (snapshots ?? [])
    .map((s) => ({
      entryDate: previousDay(String(s.snapshot_date)),
      close: Number(s.amount),
      source: String(s.source),
    }))
    // `null` y `0` no son lo mismo: un snapshot sin importe numérico NO es un
    // cierre en cero, es un dato que no tenemos. Asentarlo vaciaría el canal.
    .filter((d) => Number.isFinite(d.close))
    .filter((d) => !startEntryDate || d.entryDate >= startEntryDate);

  const skipped = (snapshots ?? []).length - days.length;

  console.log(
    `${apply ? '*** APLICANDO ***' : '--- ENSAYO (sin --apply no escribe) ---'}\n` +
      `Empresa: ${company.name} (${company.id})\n` +
      `Canal:   ${channelKey}${NO_MOVEMENT_FEED.has(channelKey) ? ' · sin extracto (línea única «Variación del saldo»)' : ''}\n` +
      `Último asiento existente: ${lastEntry?.entry_date ?? '(libro vacío)'}\n` +
      `Arranca en: ${startEntryDate ?? '(el primer snapshot)'}\n` +
      `Días a asentar: ${days.length}` +
      (skipped > 0 ? ` · ${skipped} snapshot(s) fuera de rango o sin importe usable` : '') +
      '\n',
  );

  if (days.length === 0) return;

  if (!apply) {
    for (const d of days) console.log(`  ${d.entryDate}  cierre ${d.close.toFixed(2)}  (${d.source})`);
    console.log('\nNada escrito. Repetí con --apply.');
    return;
  }

  let ok = 0;
  const errors: string[] = [];
  for (const d of days) {
    const res = await syncChannelLedgerDay(admin, company.id, channelKey, d.entryDate, d.close, {
      noMovementFeed: NO_MOVEMENT_FEED.has(channelKey),
    });
    if (res.error) {
      // Se informa y se SIGUE: un día que aborta por umbral no puede dejar el
      // resto del histórico sin asentar. Los errores se listan al final para
      // que ninguno pase desapercibido.
      errors.push(`${d.entryDate}: ${res.error}`);
      console.log(`  ${d.entryDate}  ✗ ${res.error}`);
      continue;
    }
    ok++;
    const detail = res.bootstrapped
      ? 'apertura'
      : `ajuste ${(res.adjustment ?? 0).toFixed(2)}`;
    console.log(`  ${d.entryDate}  ✓ cierre ${d.close.toFixed(2)}  (${detail})`);
  }

  console.log(`\n${ok}/${days.length} días asentados.`);
  if (errors.length > 0) {
    console.log(`${errors.length} con error:`);
    for (const e of errors) console.log(`  · ${e}`);
    process.exitCode = 1;
  }
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
