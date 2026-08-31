// ─────────────────────────────────────────────────────────────────────────────
// De dónde sale el saldo de un canal — regla ÚNICA, sin Supabase de por medio.
//
// Vivía dentro de src/lib/reports/balances-by-channel.ts, que importa
// createAdminClient y las APIs de los proveedores: importarla desde una
// pantalla ('use client') arrastraba el cliente service-role al bundle del
// navegador. Se movió acá, en un módulo PURO, para que la use el mismo código
// en los tres lados que tienen que coincidir:
//   · /balances                 (getChannelValue, cliente)
//   · /api/balances/total-consolidado (servidor)
//   · el reporte / PDF / email  (reports/balances-by-channel)
// Tres copias de esta regla fue lo que hizo divergir las pantallas en la
// auditoría 2026-08 (A1). balances-by-channel.ts la RE-EXPORTA, así que nada
// de lo que ya importaba de ahí tiene que cambiar.
// ─────────────────────────────────────────────────────────────────────────────

import { hasLedger } from '@/lib/channel-ledger';

/**
 * De dónde salió el número de la fila.
 *   · `ledger`   — saldo corrido del libro por canal (la fuente preferida).
 *   · `live`     — snapshot que acaba de escribir la API del proveedor.
 *   · `snapshot` — último snapshot diario dentro de la ventana de 30 días.
 *   · `computed` — reconstruido desde su propio módulo (liquidez/inversiones).
 *   · `missing`  — NO hay dato. El amount es 0 pero no significa "cuenta vacía".
 */
export type ReportChannelSource = 'live' | 'snapshot' | 'computed' | 'ledger' | 'missing';

export interface ReportChannelBalanceRow {
  key: string;
  label: string;
  type: 'api' | 'manual' | 'auto';
  amount: number;
  source: ReportChannelSource;
  isCustom: boolean;
}

/**
 * Clave de la fila de ajuste que reconcilia el desglose por wallet contra el
 * saldo agregado del libro de Coinsbuy. Ver `expandCoinsbuyRows`.
 */
export const COINSBUY_RECONCILE_KEY = 'coinsbuy:__ajuste';

/**
 * Elige el saldo de un canal entre las dos fuentes, con la MISMA prioridad que
 * `getChannelValue` en /balances. Pura a propósito: es la regla que la
 * auditoría encontró divergente, así que tiene que poder testearse sin
 * Supabase de por medio.
 *
 * OJO — `channelKey` tiene que ser una clave de CANAL (`coinsbuy`,
 * `unipayment`, `custom_<uuid>`…). Pasarle una sub-clave como
 * `coinsbuy:1079` era el bug del ítem 12 de la auditoría: `hasLedger()`
 * devuelve true para cualquier cosa que no sea liquidez/inversiones, así que
 * la función buscaba en el libro una clave que el libro NUNCA tiene (los
 * asientos de Coinsbuy se guardan agregados bajo `coinsbuy`) y caía al
 * snapshot sin decirlo. El reparto por wallet lo hace `expandCoinsbuyRows`.
 */
export function pickChannelAmount(params: {
  channelKey: string;
  /** Saldo del libro al cierre de `asOf`, o undefined si el canal no tiene. */
  ledgerBalance?: number;
  /** Último snapshot dentro de la ventana, o undefined si no hay. */
  snapshot?: { amount: number; source: string };
}): { amount: number; source: ReportChannelSource } {
  const { channelKey, ledgerBalance, snapshot } = params;
  if (hasLedger(channelKey) && ledgerBalance !== undefined && Number.isFinite(ledgerBalance)) {
    return { amount: ledgerBalance, source: 'ledger' };
  }
  if (snapshot) {
    return { amount: snapshot.amount, source: snapshot.source === 'api' ? 'live' : 'snapshot' };
  }
  return { amount: 0, source: 'missing' };
}

/**
 * Desglose de Coinsbuy en una fila por wallet fijada, SIN que el total del
 * canal deje de ser el que muestra /balances.
 *
 * ── EL BUG QUE ARREGLA (auditoría de finanzas, ítem 12) ─────────────────────
 * El builder expandía Coinsbuy en una fila por wallet y para cada una llamaba
 * `pickChannelAmount({ channelKey: 'coinsbuy:1079', ledgerBalance:
 * ledgerByKey.get('coinsbuy:1079') })`. Esa clave NO EXISTE en el libro: el
 * cron asienta el movimiento de Coinsbuy AGREGADO, bajo la clave `coinsbuy`
 * (get_channel_day_movements devuelve una sola fila 'coinsbuy'; verificado
 * contra producción el 2026-08-31: 164 asientos con channel_key='coinsbuy' y
 * ninguno con `coinsbuy:` como prefijo). El `ledgerByKey.get()` daba siempre
 * `undefined`, la fila caía al snapshot por wallet, y el reporte / el PDF / el
 * email terminaban sumando Σ(snapshots por wallet) mientras /balances mostraba
 * el saldo del LIBRO agregado. Dos saldos distintos del mismo canal, sin que
 * nada fallara.
 *
 * ── LA DECISIÓN ────────────────────────────────────────────────────────────
 * El número AUTORITATIVO del canal es el que sale de `pickChannelAmount` sobre
 * la clave agregada `coinsbuy` — el mismo que lee /balances y el mismo que
 * suma /api/balances/total-consolidado. Las wallets son el DESGLOSE: dicen
 * dónde está la plata, y su fuente natural es el snapshot por wallet (el
 * libro no las conoce).
 *
 * Se descartó repartir el agregado a prorrata entre las wallets: sería
 * inventar un saldo por wallet que nadie midió. Y se descartó tirar el
 * agregado y quedarse con la suma de wallets: es volver al bug.
 *
 * Cuando las dos cosas no coinciden —pasa con cualquier fecha pasada, porque
 * el libro cierra contra el saldo real del día y los snapshots por wallet son
 * la foto de las 00:00 UTC— se emite UNA fila más, explícita
 * (`coinsbuy:__ajuste`), con la diferencia. Es el mismo criterio de la
 * migración 108 con `balance_delta`: un número que no se puede desglosar se
 * muestra con su nombre, no se esconde ni se disfraza. Así el total del
 * reporte sigue siendo el de /balances Y la diferencia queda a la vista en vez
 * de ser silenciosa (§1.2 del manual: contar lo excluido y avisar).
 *
 * Pura a propósito: es aritmética de dinero, tiene que testearse sin Supabase.
 */
export function expandCoinsbuyRows(params: {
  /** Saldo agregado del canal, ya resuelto con `pickChannelAmount('coinsbuy')`. */
  aggregate: { amount: number; source: ReportChannelSource };
  pinnedWallets: Array<{ wallet_id: string; wallet_label: string }>;
  /** Snapshot por wallet, clave `coinsbuy:<wallet_id>`. */
  snapshotByKey: Map<string, { amount: number; source: string }>;
}): ReportChannelBalanceRow[] {
  const { aggregate, pinnedWallets, snapshotByKey } = params;
  const rows: ReportChannelBalanceRow[] = [];
  let walletsSum = 0;

  for (const pw of pinnedWallets) {
    const key = `coinsbuy:${pw.wallet_id}`;
    const snap = snapshotByKey.get(key);
    // Nunca `ledgerBalance`: el libro no tiene claves por wallet. Pasarle una
    // sería reintroducir el bug con otra cara.
    const picked = pickChannelAmount({ channelKey: key, snapshot: snap });
    walletsSum += picked.amount;
    rows.push({
      key,
      // Se marcan como Coinsbuy para que se lean sin contexto adicional.
      label: `Coinsbuy · ${pw.wallet_label}`,
      type: 'api',
      amount: picked.amount,
      source: picked.source,
      isCustom: false,
    });
  }

  // Medio centavo de tolerancia: el libro y los snapshots son numéricos
  // exactos, pero una diferencia de redondeo no merece una fila.
  const diff = aggregate.amount - walletsSum;
  if (Math.abs(diff) >= 0.005) {
    rows.push({
      key: COINSBUY_RECONCILE_KEY,
      label: 'Coinsbuy · ajuste del libro',
      type: 'api',
      amount: diff,
      source: aggregate.source,
      isCustom: false,
    });
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saldo EN VIVO con respaldo (auditoría de finanzas, ítem 13)
//
// /balances resolvía los canales por API así:
//     if (isToday) return pinnedWalletsTotal;      // sin fallback
// y el fetch de UniPayment tenía un catch cuyo comentario decía, literal,
// «Silent — channel shows $0 on error». Con la API caída, Coinsbuy mostraba
// $0,00 en vez de los $244.079,51 que el libro sabe.
//
// **Un $0 nunca puede ser el estado de error**: se lee como una afirmación
// sobre la plata («esta cuenta está vacía»), que es justo lo que no sabemos.
// El patrón correcto ya existía del lado del servidor
// (/api/balances/total-consolidado:163,179 cae al libro cuando la API falla);
// esta función es esa misma decisión, escrita una vez y testeable.
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveOrStored {
  amount: number;
  source: ReportChannelSource;
  /** Fecha del dato mostrado (ISO o YYYY-MM-DD). `null` si no se sabe. */
  asOf: string | null;
  /** true → se está mostrando el respaldo porque el vivo no contestó. */
  degraded: boolean;
}

/**
 * @param live      Saldo en vivo, o `null` si NO LO SABEMOS (la API no
 *                  contestó, falló, o todavía no volvió). Nunca 0 por defecto.
 * @param liveFailed ¿El vivo falló de verdad? Se separa de `live === null`
 *                  porque "todavía cargando" no merece cartel de degradado,
 *                  pero sí merece mostrar el respaldo en vez de un $0 que
 *                  parpadea.
 * @param stored    Lo que ya sabíamos (libro o snapshot), vía pickChannelAmount.
 */
export function pickLiveOrStored(params: {
  live: number | null;
  liveFailed: boolean;
  liveAsOf: string | null;
  stored: { amount: number; source: ReportChannelSource };
  storedAsOf: string | null;
}): LiveOrStored {
  const { live, liveFailed, liveAsOf, stored, storedAsOf } = params;
  if (live !== null && Number.isFinite(live)) {
    return { amount: live, source: 'live', asOf: liveAsOf, degraded: false };
  }
  return {
    amount: stored.amount,
    source: stored.source,
    asOf: storedAsOf,
    degraded: liveFailed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Antigüedad del saldo (auditoría de finanzas, ítem 23)
//
// En /balances, `otros` ($14.493, cuyo último asiento es del 2026-08-05) se
// pintaba con exactamente el mismo peso visual que Coinsbuy en vivo. El saldo
// de una ubicación manual no envejece solo: si nadie carga un asiento, el
// número se queda quieto y sigue pareciendo de hoy. Un saldo de hace tres
// semanas presentado como el de hoy es un dato equivocado con cara de dato
// bueno — el modo de falla №1 de este repo (§1.2).
//
// El umbral es 30 días, y no es un número al azar: es la MISMA ventana que ya
// usa el reporte para buscar el último snapshot
// (reports/balances-by-channel.ts busca `snapshot_date >= asOf - 30 días`).
// Fuera de esa ventana el reporte directamente considera que no hay dato
// (`source: 'missing'`), así que un saldo más viejo que eso ya era, para la
// mitad del sistema, "no lo sabemos".
// ─────────────────────────────────────────────────────────────────────────────

/** Días a partir de los cuales un saldo se marca como viejo. */
export const STALE_BALANCE_DAYS = 30;

/**
 * Días transcurridos entre `updatedAt` (YYYY-MM-DD o ISO) y `asOf`.
 * `null` cuando no se sabe la fecha — que NO es lo mismo que cero días.
 */
export function balanceAgeInDays(
  updatedAt: string | null | undefined,
  asOf: string,
): number | null {
  if (!updatedAt) return null;
  const from = Date.parse(updatedAt.length <= 10 ? `${updatedAt}T00:00:00Z` : updatedAt);
  const to = Date.parse(asOf.length <= 10 ? `${asOf}T00:00:00Z` : asOf);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const days = Math.floor((to - from) / 86_400_000);
  // Una fecha en el futuro (zona horaria del navegador contra un snapshot en
  // UTC) no es "menos 1 día de antigüedad": es cero.
  return days < 0 ? 0 : days;
}

/**
 * ¿Este saldo merece el cartel de "viejo"?
 *
 * Los canales EN VIVO (`live`) y los reconstruidos de su propio módulo
 * (`computed`) nunca son viejos: se recalculan en cada visita. `missing` no se
 * marca viejo porque ya tiene su propio cartel, más grave: no hay dato.
 */
export function isStaleBalance(params: {
  source: ReportChannelSource;
  updatedAt: string | null | undefined;
  asOf: string;
  staleDays?: number;
}): boolean {
  const { source, updatedAt, asOf, staleDays = STALE_BALANCE_DAYS } = params;
  if (source === 'live' || source === 'computed' || source === 'missing') return false;
  const age = balanceAgeInDays(updatedAt, asOf);
  if (age === null) return false;
  return age >= staleDays;
}
