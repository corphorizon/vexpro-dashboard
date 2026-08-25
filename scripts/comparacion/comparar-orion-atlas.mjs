#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Comparación Smart Dashboard ↔ Atlas, antes de apagar el sync de Atlas.
//
// LO CORRE ATLAS, NO NOSOTROS. Es deliberado: quien construyó el espejo nuevo
// no debería ser quien certifica que está bien.
//
// Consume el endpoint REAL de producción con el token real, la paginación real
// y el cursor real. Un endpoint hecho para comparar sólo probaría el endpoint
// hecho para comparar; así la comparación valida también la autenticación, el
// cursor compuesto y el comportamiento en el borde, que es donde se rompen
// estas cosas.
//
// ── EL RUIDO QUE HAY QUE SEPARAR ───────────────────────────────────────────
// Los dos espejos son fotos tomadas en instantes distintos: el de Atlas cada
// 15 minutos, el nuestro con su propia cadencia. Un cliente que depositó hace
// tres minutos VA A DIFERIR, y legítimamente. Si no se separa, el informe se
// llena de diferencias reales que no son errores y la señal se pierde.
//
// Por eso sólo se comparan los registros ESTABLES: los que llevan sin cambiar
// en el origen más que la ventana indicada. Los recientes se listan aparte,
// como esperados, nunca como fallo.
//
// ── CRITERIO DE APROBACIÓN, ACORDADO DE ANTEMANO ───────────────────────────
// CERO diferencias en los once campos que mueven filtros y órdenes de La Base,
// sobre los registros estables. En el resto, diferencias explicadas.
//
// ── USO ────────────────────────────────────────────────────────────────────
//   SDK_TOKEN=sdk_...  node comparar-orion-atlas.mjs --atlas ./atlas.json
//
// donde atlas.json es un volcado de las filas de Atlas con esta forma:
//   [{ "email": "...", "status": "...", "kycStatus": "...", "kycLevel": "...",
//      "balanceUsd": 0, "totalDeposits": 0, "depositCount": 0,
//      "lastDepositAt": null, "liveAccountsCount": 0,
//      "enabledWithdrawals": true, "registerDate": "...", "clientId": "...",
//      "sourceUpdatedAt": "..." }, ...]
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';

const BASE = process.env.SDK_BASE ?? 'https://dashboard.horizonconsulting.ai';
const TOKEN = process.env.SDK_TOKEN;
if (!TOKEN) {
  console.error('Falta SDK_TOKEN (el token de Atlas). No se guarda en el script a propósito.');
  process.exit(1);
}

const args = process.argv.slice(2);
const atlasPath = args[args.indexOf('--atlas') + 1];
if (!atlasPath || atlasPath.startsWith('--')) {
  console.error('Uso: SDK_TOKEN=... node comparar-orion-atlas.mjs --atlas ./atlas.json [--ventana-min 30]');
  process.exit(1);
}
const ventanaMin = Number(args[args.indexOf('--ventana-min') + 1]) || 30;

/**
 * Los once que deciden. Una sola diferencia acá reprueba la comparación: son
 * los que mueven filtros y órdenes de La Base, o sea a quién ve y a quién
 * llama el call center.
 */
const CAMPOS_CRITICOS = [
  ['status', 'status'],
  ['kycStatus', 'kycStatus'],
  ['kycLevel', 'kycLevel'],
  ['walletBalance', 'balanceUsd'],
  ['totalDeposits', 'totalDeposits'],
  ['depositCount', 'depositCount'],
  ['lastDepositAt', 'lastDepositAt'],
  ['liveAccountsCount', 'liveAccountsCount'],
  ['enabledWithdrawals', 'enabledWithdrawals'],
  ['registerDate', 'registerDate'],
  ['clientId', 'clientId'],
];

/** Compara respetando que null y 0 NO son lo mismo. */
function iguales(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === 'number' || typeof b === 'number') {
    const x = Number(a), y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a) === String(b);
    // ── TOLERANCIA DE UN CENTAVO, CON EPSILON ────────────────────────────
    // El epsilon no es paranoia: una diferencia de exactamente un centavo se
    // calcula en coma flotante como 0.010000000000218279, así que `< 0.01`
    // la marca como diferencia. Pasó en la corrida del 2026-08-25: un cliente
    // cuya suma cruda en Orion es 9066.845000000001 —medio centavo justo— dio
    // 9066.85 de un lado y 9066.84 del otro, y ninguno estaba equivocado.
    //
    // Sin esto NINGUNA corrida puede aprobar mientras los importes se guarden
    // como float: siempre habrá algún cliente cuya suma caiga en el filo.
    return Math.abs(x - y) <= 0.01 + 1e-9;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  // Fechas: se comparan como instante, no como texto.
  const da = Date.parse(String(a)), db = Date.parse(String(b));
  if (Number.isFinite(da) && Number.isFinite(db)) return Math.abs(da - db) < 1000;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

async function traerTodos() {
  const items = [];
  let since = '1970-01-01T00:00:00.000Z';
  let afterId = null;
  let paginas = 0;
  for (;;) {
    const url = new URL('/api/partner/v1/customers', BASE);
    url.searchParams.set('since', since);
    url.searchParams.set('limit', '1000');
    if (afterId) url.searchParams.set('afterId', afterId);
    const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status} al paginar (página ${paginas + 1})`);
    const body = await res.json();
    items.push(...body.items);
    paginas++;
    process.stdout.write(`\r  descargando… ${items.length} clientes en ${paginas} páginas`);
    if (!body.hasMore) break;
    since = body.nextSince;
    afterId = body.nextAfterId;
  }
  process.stdout.write('\n');
  return items;
}

const atlas = JSON.parse(readFileSync(atlasPath, 'utf8'));
console.log(`Atlas: ${atlas.length} filas leídas de ${atlasPath}`);

const nuestros = await traerTodos();
const porCorreo = new Map(nuestros.filter((c) => c.email).map((c) => [c.email.trim().toLowerCase(), c]));

const corte = Date.now() - ventanaMin * 60 * 1000;
const faltantes = [];
const sobrantes = [];
const recientes = [];
const difCriticas = [];
const difMenores = [];

for (const a of atlas) {
  const mail = (a.email ?? '').trim().toLowerCase();
  if (!mail) continue;
  const n = porCorreo.get(mail);
  if (!n) { faltantes.push(mail); continue; }
  porCorreo.delete(mail);

  // Un registro que cambió hace poco puede diferir legítimamente.
  const cambio = Date.parse(a.sourceUpdatedAt ?? n.sourceUpdatedAt ?? '');
  if (Number.isFinite(cambio) && cambio > corte) { recientes.push(mail); continue; }

  for (const [nuestro, suyo] of CAMPOS_CRITICOS) {
    if (!iguales(n[nuestro], a[suyo])) {
      difCriticas.push({ email: mail, campo: suyo, atlas: a[suyo], nuestro: n[nuestro] });
    }
  }
}
for (const [mail] of porCorreo) sobrantes.push(mail);

const estables = atlas.length - recientes.length - faltantes.length;
console.log('\n══════════════ RESULTADO ══════════════');
console.log(`  filas de Atlas          : ${atlas.length}`);
console.log(`  clientes nuestros       : ${nuestros.length}`);
console.log(`  comparados (estables)   : ${estables}`);
console.log(`  recientes (esperado)    : ${recientes.length}  — cambiaron hace < ${ventanaMin} min`);
console.log(`  en Atlas y no en nosotros: ${faltantes.length}`);
console.log(`  en nosotros y no en Atlas: ${sobrantes.length}`);
console.log(`\n  DIFERENCIAS CRÍTICAS    : ${difCriticas.length}`);

if (difCriticas.length > 0) {
  const porCampo = {};
  for (const d of difCriticas) porCampo[d.campo] = (porCampo[d.campo] ?? 0) + 1;
  console.log('\n  por campo:');
  for (const [c, n] of Object.entries(porCampo).sort((x, y) => y[1] - x[1])) {
    console.log(`    ${c.padEnd(20)} ${n}`);
  }
  console.log('\n  primeras 10:');
  for (const d of difCriticas.slice(0, 10)) {
    console.log(`    ${d.email} · ${d.campo}: Atlas=${JSON.stringify(d.atlas)} nosotros=${JSON.stringify(d.nuestro)}`);
  }
}
if (faltantes.length > 0) console.log('\n  faltantes (5):', faltantes.slice(0, 5).join(', '));

const aprueba = difCriticas.length === 0 && faltantes.length === 0;
console.log(`\n  VEREDICTO: ${aprueba ? 'APRUEBA — cero diferencias críticas' : 'NO APRUEBA'}`);
console.log('  (el criterio es cero diferencias en los once campos que mueven filtros y órdenes)');
process.exit(aprueba ? 0 : 1);
