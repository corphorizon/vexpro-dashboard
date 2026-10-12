// ─────────────────────────────────────────────────────────────────────────────
// movements-ledger — las transacciones de las pasarelas como FILAS DE LIBRO,
// puras y testeables (rediseño «Libro mayor», 2026-10-12).
//
// POR QUÉ: el desglose /movimientos/desglose/[slug] tenía CINCO tablas a mano,
// una por proveedor, cada una con su campo de monto, su lista de status
// «aceptados» pintados de verde y su forma de esconder lo que no cuenta. La
// pantalla nueva es UN libro (Hora, Cliente·ID, Canal, Tipo, Estado, Monto)
// agrupado por día con el neto diario; para eso cada proveedor se traduce acá,
// una sola vez, a la misma forma.
//
// QUÉ NO DECIDE ESTE ARCHIVO: qué fila «cuenta» para el total. Eso vive en
// `computeProviderTotals` / `countPayprosPayouts` (api-integrations/totals.ts),
// que es lo que suma la tarjeta y lo que consume Net Deposit. `counts` de cada
// fila se escribe con los MISMOS criterios y el test
// (movements-ledger.test.ts) fija que Σ filas que cuentan === total canónico
// para cada proveedor: si alguien cambia uno sin el otro, el test rompe en vez
// de que la tabla y el KPI digan dos números distintos (reglas §1.1).
//
// MEDICIÓN: no hay dato nuevo — el monto de cada fila es el campo que ya usaba
// la tabla de su proveedor (amountTarget, chargedAmount, net, netAmount,
// amount); el desglose sigue leyendo de /persisted-movements.
//
// DESCARTADO:
//   · Un campo `amount` común en `ProviderTransaction`: tocaría el contrato del
//     endpoint, del persist y del fetcher por algo que es sólo de pantalla.
//   · Agrupar por día en UTC: el resto de la app muestra hora local
//     (`formatDateTime`); un depósito de las 22:30 de Lima caería «mañana».
// ─────────────────────────────────────────────────────────────────────────────

import { statusKind, type StatusKind } from '@/components/ui/status-kind';
import { ACCEPTED_STATUS, PAYPROS_PAYOUT_STATUS } from '@/lib/api-integrations/totals';
import { PROVIDER_META } from '@/lib/api-channels';
import type {
  CoinsbuyDepositTx,
  CoinsbuyWithdrawalTx,
  FairpayDepositTx,
  PayprosDepositTx,
  ProviderDataset,
  ProviderSlug,
  ProviderTransaction,
  UnipaymentDepositTx,
} from '@/lib/api-integrations/types';

export type LedgerDirection = 'deposit' | 'withdrawal';

/**
 * Por qué una fila está (o no) en el total. Exclusivo, en este orden:
 * excluida a mano > interna > cuenta > pendiente > rechazada > otra.
 */
export type LedgerCategory = 'counts' | 'pending' | 'rejected' | 'excluded' | 'internal' | 'other';

export interface LedgerRow {
  id: string;
  slug: ProviderSlug;
  /** ISO de la transacción. */
  at: string;
  /** Quién: label de Coinsbuy, email de FairPay/Unipayment, referencia de Pay-Pros. */
  client: string;
  /** Identificador que el usuario copia para buscar en el proveedor (mono). */
  clientId: string;
  /** Proveedor legible (sin el sentido). */
  channel: string;
  /** Wallet de Coinsbuy, si la hay. */
  wallet: string | null;
  direction: LedgerDirection;
  status: string;
  statusKind: StatusKind;
  /** Monto canónico del proveedor, siempre ≥ 0 tal como viene. */
  amount: number;
  /** Comisión. null = el proveedor no la informa (Pay-Pros), que no es 0. */
  fee: number | null;
  /** Entra al total del proveedor (mismos criterios que computeProviderTotals). */
  counts: boolean;
  category: LedgerCategory;
  /** La transacción original (para acciones de fila: excluir/restaurar). */
  tx: ProviderTransaction;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function categoryOf(r: { excluded: boolean; internal: boolean; counts: boolean; kind: StatusKind }): LedgerCategory {
  if (r.excluded) return 'excluded';
  if (r.internal) return 'internal';
  if (r.counts) return 'counts';
  if (r.kind === 'pend') return 'pending';
  if (r.kind === 'bad') return 'rejected';
  return 'other';
}

/** Una transacción de un proveedor → fila de libro. */
export function toLedgerRow(slug: ProviderSlug, tx: ProviderTransaction): LedgerRow {
  const channel = PROVIDER_META[slug]?.provider ?? slug;
  const base = { slug, channel, tx, at: tx.createdAt };
  switch (slug) {
    case 'coinsbuy-deposits': {
      const t = tx as CoinsbuyDepositTx;
      const excluded = t.excluded === true;
      const counts = t.status === ACCEPTED_STATUS['coinsbuy-deposits'] && !excluded;
      const kind = statusKind('apiTx', t.status);
      return {
        ...base,
        id: String(t.id),
        client: t.label ?? '',
        clientId: t.trackingId ?? String(t.id),
        wallet: t.walletLabel ?? t.walletId ?? null,
        direction: 'deposit',
        status: t.status,
        statusKind: kind,
        amount: num(t.amountTarget),
        fee: num(t.commission),
        counts,
        category: categoryOf({ excluded, internal: false, counts, kind }),
      };
    }
    case 'coinsbuy-withdrawals': {
      const t = tx as CoinsbuyWithdrawalTx;
      const excluded = t.excluded === true;
      const internal = t.internal === true;
      const counts = t.status === ACCEPTED_STATUS['coinsbuy-withdrawals'] && !excluded && !internal;
      const kind = statusKind('apiTx', t.status);
      return {
        ...base,
        id: String(t.id),
        client: t.label ?? '',
        clientId: t.trackingId ?? String(t.id),
        wallet: t.walletLabel ?? t.walletId ?? null,
        direction: 'withdrawal',
        status: t.status,
        statusKind: kind,
        amount: num(t.chargedAmount),
        fee: num(t.commission),
        counts,
        category: categoryOf({ excluded, internal, counts, kind }),
      };
    }
    case 'fairpay': {
      const t = tx as FairpayDepositTx;
      const counts = t.status === ACCEPTED_STATUS.fairpay;
      const kind = statusKind('apiTx', t.status);
      return {
        ...base,
        id: String(t.id),
        client: t.customerEmail ?? '',
        clientId: String(t.id),
        wallet: null,
        direction: 'deposit',
        status: t.status,
        statusKind: kind,
        amount: num(t.net),
        fee: num(t.mdr),
        counts,
        category: categoryOf({ excluded: false, internal: false, counts, kind }),
      };
    }
    case 'unipayment': {
      const t = tx as UnipaymentDepositTx;
      const counts = t.status === ACCEPTED_STATUS.unipayment;
      const kind = statusKind('apiTx', t.status);
      return {
        ...base,
        id: String(t.id),
        client: t.email ?? '',
        clientId: t.orderId ?? String(t.id),
        wallet: null,
        direction: 'deposit',
        status: t.status,
        statusKind: kind,
        amount: num(t.netAmount),
        fee: num(t.fee),
        counts,
        category: categoryOf({ excluded: false, internal: false, counts, kind }),
      };
    }
    case 'paypros': {
      // Un solo provider con los dos sentidos: el status decide (ver
      // withdrawal-channels.ts). 'paid' cuenta como depósito, 'payout_paid'
      // como retiro; nada más mueve caja. Un 'payout_declined' es un RETIRO
      // rechazado (sentido retiro, no cuenta), no un depósito.
      const t = tx as PayprosDepositTx;
      const isPayout = String(t.status ?? '').startsWith('payout_') || t.kind === 'withdrawal';
      const counts = isPayout ? t.status === PAYPROS_PAYOUT_STATUS : t.status === ACCEPTED_STATUS.paypros;
      const kind = statusKind('paypros', t.status);
      return {
        ...base,
        id: String(t.id),
        client: t.notifyReference ?? '',
        clientId: String(t.id),
        wallet: null,
        direction: isPayout ? 'withdrawal' : 'deposit',
        status: t.status,
        statusKind: kind,
        amount: num(t.amount),
        fee: null, // Pay-Pros no informa comisión (totals.ts: feeTotal 0 = «no lo dice»)
        counts,
        category: categoryOf({ excluded: false, internal: false, counts, kind }),
      };
    }
  }
}

/** Todas las filas de un dataset, más nuevas primero (el libro se lee de arriba). */
export function ledgerRows(ds: ProviderDataset): LedgerRow[] {
  return ds.transactions
    .map((tx) => toLedgerRow(ds.slug, tx))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Monto con signo: un depósito suma, un retiro resta. */
export function signedAmount(r: Pick<LedgerRow, 'amount' | 'direction'>): number {
  return r.direction === 'withdrawal' ? -r.amount : r.amount;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Día LOCAL de la fila («2026-10-12»). Fecha inválida → 'sin-fecha' (se cuenta aparte, no se pierde). */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'sin-fecha';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Hora local «14:05». */
export function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Neto por día sobre las filas QUE CUENTAN (depósitos − retiros), calculado
 * sobre TODAS las filas que se le pasan — el llamador pasa la lista filtrada
 * entera, no la página: con paginación, el neto de un día partido entre dos
 * páginas sería la mitad con cara de total (reglas §1.2).
 *
 * Un día cuyas filas no cuentan (todas pendientes/rechazadas) da 0: acá el
 * cero ES una afirmación — sabemos que ese día no se movió plata —, no un
 * «no sabemos» disfrazado (reglas §1.3).
 */
export function dailyNet(rows: readonly LedgerRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = dayKey(r.at);
    if (!(k in out)) out[k] = 0;
    if (!r.counts) continue;
    out[k] = Math.round((out[k] + signedAmount(r)) * 100) / 100;
  }
  return out;
}

/** Σ con signo de las filas que cuentan. */
export function countedNet(rows: readonly LedgerRow[]): number {
  let sum = 0;
  for (const r of rows) if (r.counts) sum += signedAmount(r);
  return Math.round(sum * 100) / 100;
}

export interface LedgerCounts {
  all: number;
  deposit: number;
  withdrawal: number;
  byCategory: Record<LedgerCategory, number>;
}

export function ledgerCounts(rows: readonly LedgerRow[]): LedgerCounts {
  const byCategory: Record<LedgerCategory, number> = {
    counts: 0,
    pending: 0,
    rejected: 0,
    excluded: 0,
    internal: 0,
    other: 0,
  };
  let deposit = 0;
  for (const r of rows) {
    byCategory[r.category] += 1;
    if (r.direction === 'deposit') deposit += 1;
  }
  return { all: rows.length, deposit, withdrawal: rows.length - deposit, byCategory };
}

export interface LedgerFilter {
  direction: 'all' | LedgerDirection;
  /** Categorías visibles. Vacío = todas. */
  categories: readonly LedgerCategory[];
  query: string;
}

/**
 * Búsqueda libre, sin distinguir mayúsculas, sobre lo que se ve en la fila:
 * cliente, ID, wallet, status, monto y fecha. Antes existía sólo para
 * Coinsbuy; ahora vale para todos los proveedores con la misma regla.
 */
export function matchesLedgerQuery(r: LedgerRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [r.client, r.clientId, r.id, r.wallet, r.status, r.at, String(r.amount), r.fee == null ? '' : String(r.fee)]
    .filter((v) => v != null && v !== '')
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

export function filterLedger(rows: readonly LedgerRow[], f: LedgerFilter): LedgerRow[] {
  return rows.filter(
    (r) =>
      (f.direction === 'all' || r.direction === f.direction) &&
      (f.categories.length === 0 || f.categories.includes(r.category)) &&
      matchesLedgerQuery(r, f.query),
  );
}

/**
 * Lo que está EN JUEGO: transacciones pendientes (status de color `pend`) que
 * no fueron excluidas a mano. Para el KPI «Pendientes» de /movimientos.
 * `null` si no hay datasets que mirar (no lo sabemos), nunca {0, 0} inventado.
 */
export function pendingFromDatasets(
  datasets: readonly ProviderDataset[],
): { count: number; amount: number; channels: string[] } | null {
  if (datasets.length === 0) return null;
  let count = 0;
  let amount = 0;
  const channels = new Set<string>();
  for (const ds of datasets) {
    for (const tx of ds.transactions) {
      const r = toLedgerRow(ds.slug, tx);
      if (r.category !== 'pending') continue;
      count += 1;
      amount += r.amount;
      channels.add(r.channel);
    }
  }
  return { count, amount: Math.round(amount * 100) / 100, channels: [...channels] };
}
