// ─────────────────────────────────────────────────────────────────────────────
// channel-rows — las filas de «Depósitos por canal» y «Retiros por canal» de
// /movimientos, armadas sin React para poder testearlas
// (rediseño «Libro mayor», 2026-10-12).
//
// POR QUÉ: la tabla vieja ponía `?? 0` en el lado API de cada canal de
// depósito. Si /persisted-movements no respondía (o todavía no había
// respondido), FairPay mostraba «$0.00» — un número plausible y falso, porque
// no sabemos (reglas §1.3). Los retiros ya distinguían `null`, pero la
// exclusión se decía en una línea ámbar al pie que no nombraba cuántos canales
// SÍ estaban. Acá:
//   · `amount: null` = no sabemos → «—» + «Sin dato», y el pie dice
//     «Total retiros (1 de 2 canales)».
//   · `sums` dice si la fila entra al total. En Retiros hay filas que se
//     muestran y NO suman (Comisiones IB, Prop Firm, Otros, P2P): antes
//     convivían con las que suman sin distinción, y una fila de $180.000 sobre
//     un total que no la incluye se lee como un error de suma.
//
// LO QUE NO HACE: calcular los totales. Depósitos/Retiros/Net Deposit siguen
// saliendo de `computeDerivedNetDeposit` y `summary` en la página; estas filas
// son su desglose. El test fija que Σ filas que suman === total que la página
// muestra para los casos medidos (derivado e histórico).
//
// Qué categoría de retiro suma (la regla vive en dos lugares que NO se tocan):
//   · período DERIVADO (abr-2026+): `computeDerivedNetDeposit`
//     (broker-logic.ts) = API + manual «broker». IB / Prop Firm / Otros son
//     informativas (Kevin, 2026-06-06).
//   · período HISTÓRICO: `summary.totalWithdrawals` (data-context.tsx) = todas
//     las categorías menos 'prop_firm' (Kevin, 2026-08-06: prop firm es un
//     circuito aparte).
//
// DESCARTADO: mover esas dos reglas acá. Son fórmulas de dinero con historia
// propia y consumidores (distribución, reportes); duplicarlas en una tercera
// copia «de pantalla» es justo el modo de falla número uno (§1.1). Por eso
// `withdrawalCategorySums` sólo ROTULA y el test cruza contra
// `computeDerivedNetDeposit`.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChannelRow {
  key: string;
  label: string;
  /** Monto mostrado. null = no lo sabemos (el canal de API no respondió). */
  amount: number | null;
  /** Parte API (null = sin dato; 0 en canales manuales y períodos históricos). */
  apiAmount: number | null;
  manualAmount: number;
  /** De dónde sale el número: rótulo de la fila. */
  source: 'api' | 'manual' | 'api+manual';
  /** Entra al total del panel. */
  sums: boolean;
  /** Es un canal con API (cuenta para «N de M canales»). */
  isApi: boolean;
}

export interface DepositRowsInput {
  /** Canales visibles en orden de pantalla (ya sin los apagados). */
  channels: readonly string[];
  /** ¿El período usa la regla derivada (API + manual)? */
  derived: boolean;
  /** Slug de API del canal, o null si es manual puro. */
  apiSlugOf: (channel: string) => string | null;
  /** Monto de API del slug. null = el dataset no llegó. */
  apiAmountOf: (slug: string) => number | null;
  manualOf: (channel: string) => number;
  labelOf: (channel: string) => string;
}

export function buildDepositRows(input: DepositRowsInput): ChannelRow[] {
  return input.channels.map((ch) => {
    const slug = input.apiSlugOf(ch);
    const manual = input.manualOf(ch) || 0;
    const useApi = input.derived && slug !== null;
    const api = useApi ? input.apiAmountOf(slug) : 0;
    const amount = useApi ? (api === null ? null : api + manual) : manual;
    const source: ChannelRow['source'] = !useApi ? 'manual' : manual !== 0 && api !== 0 ? 'api+manual' : 'api';
    return {
      key: ch,
      label: input.labelOf(ch),
      amount,
      apiAmount: api,
      manualAmount: manual,
      source,
      sums: true,
      isApi: useApi,
    };
  });
}

/** ¿Esta categoría manual de retiro entra a «Retiros Totales»? Ver la cabecera. */
export function withdrawalCategorySums(category: string, derived: boolean): boolean {
  if (derived) return category === 'broker';
  return category !== 'prop_firm';
}

export interface WithdrawalRowsInput {
  derived: boolean;
  /** Canales de API visibles (vacío en períodos históricos). null = sin dato. */
  apiChannels: readonly { key: string; label: string; amount: number | null }[];
  /** Categorías manuales con el monto que muestra la fila y su procedencia. */
  categories: readonly { key: string; label: string; amount: number; source: 'api' | 'manual' }[];
  /** P2P: informativa siempre (no suma a ningún total). */
  p2p: { label: string; amount: number; source: 'api' | 'manual' };
}

export function buildWithdrawalRows(input: WithdrawalRowsInput): ChannelRow[] {
  const api: ChannelRow[] = input.derived
    ? input.apiChannels.map((c) => ({
        key: `api:${c.key}`,
        label: c.label,
        amount: c.amount,
        apiAmount: c.amount,
        manualAmount: 0,
        source: 'api' as const,
        sums: true,
        isApi: true,
      }))
    : [];
  const manual: ChannelRow[] = input.categories.map((c) => ({
    key: `cat:${c.key}`,
    label: c.label,
    amount: c.amount,
    apiAmount: c.source === 'api' ? c.amount : 0,
    manualAmount: c.source === 'manual' ? c.amount : 0,
    source: c.source,
    sums: withdrawalCategorySums(c.key, input.derived),
    isApi: false,
  }));
  const p2p: ChannelRow = {
    key: 'p2p',
    label: input.p2p.label,
    amount: input.p2p.amount,
    apiAmount: input.p2p.source === 'api' ? input.p2p.amount : 0,
    manualAmount: input.p2p.source === 'manual' ? input.p2p.amount : 0,
    source: input.p2p.source,
    sums: false,
    isApi: false,
  };
  // Primero lo que suma (API y luego manual), después lo informativo: el
  // orden de lectura es el de la suma.
  const all = [...api, ...manual, p2p];
  return [...all.filter((r) => r.sums), ...all.filter((r) => !r.sums)];
}

/**
 * «4 de 5 canales»: de las filas que SUMAN, cuántas tienen dato. Si `withData`
 * < `total`, el total del panel excluye algo y la etiqueta del pie lo dice.
 */
export function channelCoverage(rows: readonly ChannelRow[]): {
  withData: number;
  total: number;
  missing: ChannelRow[];
} {
  const summing = rows.filter((r) => r.sums);
  const missing = summing.filter((r) => r.amount === null);
  return { withData: summing.length - missing.length, total: summing.length, missing };
}

/**
 * Participación de una fila sobre el total, en %. null si no se puede decir:
 * fila sin dato, fila que no suma, o total ≤ 0 (un % sobre un total negativo
 * o cero no significa nada).
 */
export function sharePct(row: Pick<ChannelRow, 'amount' | 'sums'>, total: number | null): number | null {
  if (!row.sums || row.amount === null || total === null || !(total > 0)) return null;
  return (row.amount / total) * 100;
}

/** Σ de las filas que suman y tienen dato (para cruzar contra el total de la página en tests). */
export function sumOfRows(rows: readonly ChannelRow[]): number {
  return Math.round(rows.reduce((s, r) => s + (r.sums && r.amount !== null ? r.amount : 0), 0) * 100) / 100;
}
