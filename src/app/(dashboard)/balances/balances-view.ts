// ─────────────────────────────────────────────────────────────────────────────
// balances-view — lo que la tabla «Saldo por canal» decide y no es dibujo:
// a qué grupo va cada canal, de qué fuente sale, qué tan fresco es, qué entra a
// la barra de distribución y cuántos canales suman de verdad. Puro (sin React
// ni Supabase) para testearlo — balances-view.test.ts.
//
// POR QUÉ (2026-10-12, rediseño «Libro mayor» de Balances): la tarjeta vieja
// decidía todo esto dentro del JSX, fila por fila, y había tres cosas que no se
// podían verificar sin abrir el navegador:
//   · un canal SIN DATO (`source: 'missing'`) se pintaba «$0.00» igual que una
//     wallet vacía — «no lo sabemos» leído como «es cero» (reglas §1.3). Acá su
//     saldo es `null` («—») y se cuenta aparte;
//   · los canales ocultos desde «Configurar» desaparecían del total sin que el
//     total lo dijera (reglas §1.2: una exclusión silenciosa es indistinguible
//     de un cruce roto). Acá se cuentan: «N sumados, M excluidos»;
//   · los desactualizados se marcaban con un badge por fila, pero nadie sumaba
//     cuánta plata vieja estaba entrando al total. Acá `freshnessSummary` da
//     los nombres Y el monto, para el banner `stale`.
//
// Las CUENTAS no se reimplementan: el total y Disponible/Prestado/Deuda salen
// de `summarize`/`tallyCash` (cash-locations.ts) y el signo de una deuda de
// `signedBalance`. Este archivo sólo clasifica filas.
//
// Grupos: el mapa tipo → grupo está tipado `Record<LocationType, …>` contra el
// catálogo canónico (LOCATION_TYPES): si mañana aparece un tipo nuevo, `tsc`
// falla acá en vez de caer en silencio a un grupo cualquiera. NO es una segunda
// lista de tipos: es la forma de mostrarlos.
//
// DESCARTADO:
//   · Un grupo por cada tipo (7): «Efectivo» y «Cuenta de trading» suelen tener
//     uno o ningún canal y la tabla quedaba con más filas de grupo que de
//     datos. Van con bancos/exchanges, que es lo que son para conciliar.
//   · Contar como «sin dato» a un canal en $0 con fuente conocida: un 0 del
//     libro ES un dato (la cuenta está vacía).
// ─────────────────────────────────────────────────────────────────────────────

import { isAutoLedger } from '@/lib/channel-ledger';
import type { ReportChannelSource } from '@/lib/channel-balance-source';
import {
  isLiquid,
  isOnchain,
  normalizeLocationType,
  signedBalance,
  type LocationType,
} from '@/lib/cash-locations';

export type ChannelGroupKey = 'gateway' | 'wallet' | 'bank' | 'lent' | 'debt';

/** Orden de los grupos en la tabla: lo líquido primero, lo que no es caja al final. */
export const CHANNEL_GROUP_ORDER: readonly ChannelGroupKey[] = ['gateway', 'wallet', 'bank', 'lent', 'debt'];

export const CHANNEL_GROUP_OF_TYPE: Record<LocationType, ChannelGroupKey> = {
  gateway: 'gateway',
  wallet: 'wallet',
  bank: 'bank',
  cash: 'bank',
  trading: 'bank',
  loan: 'lent',
  debt: 'debt',
};

export function channelGroupOf(type: unknown): ChannelGroupKey {
  return CHANNEL_GROUP_OF_TYPE[normalizeLocationType(type)];
}

/** De dónde sale el saldo, para la etiqueta `src` (API / On-chain / Manual). */
export type ChannelSourceKind = 'api' | 'onchain' | 'manual' | 'computed';

export function channelSourceKind(
  loc: { channel_key: string; onchain_wallets?: unknown },
  source?: ReportChannelSource,
): ChannelSourceKind {
  // liquidez / inversiones: reconstruidos de su propio módulo, no se cargan.
  if (source === 'computed') return 'computed';
  if (isOnchain(loc)) return 'onchain';
  if (isAutoLedger(loc.channel_key)) return 'api';
  return 'manual';
}

/**
 * Qué tan fresco es el saldo mostrado.
 *   · live     — en vivo de la API, este segundo.
 *   · fresh    — del libro/snapshot, dentro de la ventana.
 *   · stale    — viejo (≥ 30 días sin asiento): sigue sumando.
 *   · degraded — la API no contestó y se muestra el respaldo: sigue sumando.
 *   · missing  — NO hay dato: no suma (cuenta como 0 en `tallyCash`).
 * `missing` gana sobre `degraded`: si la API cayó y además no hay respaldo, lo
 * grave es que no hay número.
 */
export type Freshness = 'live' | 'fresh' | 'stale' | 'degraded' | 'missing';

export interface BalanceMeta {
  source: ReportChannelSource;
  asOf: string | null;
  degraded: boolean;
  stale: boolean;
}

export function channelFreshness(meta: BalanceMeta | undefined): Freshness {
  if (!meta) return 'fresh';
  if (meta.source === 'missing') return 'missing';
  if (meta.degraded) return 'degraded';
  if (meta.stale) return 'stale';
  if (meta.source === 'live') return 'live';
  return 'fresh';
}

/** Lo mínimo de una ubicación que necesita una fila (CashLocation o AllocatedLocation). */
export interface RowSource {
  channel_key: string;
  label: string;
  location_type: LocationType | string;
  holder: string | null;
  balance: number;
  onchain_wallets?: unknown;
  /** Parte de la ubicación (vista por unidad). 1 si no hay reparto. */
  share?: number;
  /** Saldo completo de la ubicación cuando `balance` es una porción. */
  fullBalance?: number;
}

export interface ChannelRow {
  /** Única en la tabla: en la vista por unidad un canal compartido aparece en varias. */
  rowKey: string;
  channelKey: string;
  label: string;
  type: LocationType;
  group: ChannelGroupKey;
  /** Unidad de negocio del grupo (vista por unidad); '' = sin unidad. */
  unitKey: string;
  holder: string | null;
  /** Saldo tal como está guardado (positivo en una deuda). */
  balance: number;
  /** Aporte al total: negativo en una deuda. `null` = sin dato (nunca 0 inventado). */
  signed: number | null;
  liquid: boolean;
  source: ChannelSourceKind;
  freshness: Freshness;
  asOf: string | null;
  share: number;
  fullBalance: number;
}

export function buildChannelRow(
  loc: RowSource,
  meta: BalanceMeta | undefined,
  unitKey = '',
): ChannelRow {
  const type = normalizeLocationType(loc.location_type);
  const freshness = channelFreshness(meta);
  const balance = Number(loc.balance) || 0;
  return {
    rowKey: unitKey ? `${unitKey}:${loc.channel_key}` : loc.channel_key,
    channelKey: loc.channel_key,
    label: loc.label,
    type,
    group: channelGroupOf(type),
    unitKey,
    holder: loc.holder,
    balance,
    signed: freshness === 'missing' ? null : signedBalance({ location_type: type, balance }),
    liquid: isLiquid(type),
    source: channelSourceKind(loc, meta?.source),
    freshness,
    asOf: meta?.asOf ?? null,
    share: loc.share ?? 1,
    fullBalance: loc.fullBalance ?? balance,
  };
}

/**
 * Ordena por grupo (CHANNEL_GROUP_ORDER) conservando el orden de entrada dentro
 * de cada grupo (el `sort_order` que ya trae la configuración). FinTable agrupa
 * por primera aparición: sin esto, un banco entre dos pasarelas partiría el
 * grupo «Pasarelas» en dos.
 */
export function sortByGroup<R extends { group: ChannelGroupKey }>(rows: R[]): R[] {
  const rank = (g: ChannelGroupKey) => CHANNEL_GROUP_ORDER.indexOf(g);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r.group) - rank(b.r.group) || a.i - b.i)
    .map(({ r }) => r);
}

export interface ChannelCount {
  /** Canales con dato que entran al total. */
  summed: number;
  /** Visibles sin dato: «suman» 0, o sea, no suman. */
  missing: number;
  /** Ocultos desde «Configurar»: fuera del total. */
  hidden: number;
  /** missing + hidden — lo que el pie llama «excluidos». */
  excluded: number;
}

/** Una fila por canal (vista por tipo), no por porción de unidad. */
export function countChannels(rows: Array<Pick<ChannelRow, 'freshness'>>, hidden: number): ChannelCount {
  const missing = rows.filter((r) => r.freshness === 'missing').length;
  const h = Math.max(0, Math.trunc(hidden) || 0);
  return { summed: rows.length - missing, missing, hidden: h, excluded: missing + h };
}

export interface FreshnessSummary {
  /** Viejos o con la API caída: siguen sumando. */
  outdated: { labels: string[]; amount: number };
  /** Sin dato: no suman. */
  missing: { labels: string[] };
}

/**
 * Para los banners: quiénes están desactualizados y CUÁNTO siguen sumando
 * (con signo: una deuda vieja resta), y quiénes no tienen dato.
 */
export function freshnessSummary(rows: ChannelRow[]): FreshnessSummary {
  const outdated = rows.filter((r) => r.freshness === 'stale' || r.freshness === 'degraded');
  const amount = outdated.reduce((s, r) => s + (r.signed ?? 0), 0);
  return {
    outdated: { labels: outdated.map((r) => r.label), amount: Math.round(amount * 100) / 100 },
    missing: { labels: rows.filter((r) => r.freshness === 'missing').map((r) => r.label) },
  };
}

/**
 * Entradas de la barra «Distribución del disponible» (spec §7): sólo lo
 * LÍQUIDO, antes de restar deuda. Prestado y deudas no entran (no son caja).
 * Un canal sin dato entra como `null` para que la barra lo cuente como «sin
 * dato» en vez de tratarlo como un 0 — mismos números que la tabla.
 */
export function distributionInputs(
  rows: ChannelRow[],
): Array<{ key: string; label: string; value: number | null; stale: boolean }> {
  return rows
    .filter((r) => r.liquid)
    .map((r) => ({
      key: r.rowKey,
      label: r.label,
      value: r.signed,
      stale: r.freshness === 'stale' || r.freshness === 'degraded',
    }));
}

/**
 * % del líquido de una fila. `null` cuando no aplica (prestado, deuda, sin
 * dato) o no hay base positiva — nunca un «0 %» que parezca un dato.
 */
export function liquidSharePct(row: Pick<ChannelRow, 'liquid' | 'signed'>, liquidTotal: number): number | null {
  if (!row.liquid || row.signed === null) return null;
  if (!(liquidTotal > 0)) return null;
  return (row.signed / liquidTotal) * 100;
}
