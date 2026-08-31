// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Totals + date filtering helpers
//
// Each provider has a different field that counts as "the amount" and a
// different status string that counts as "accepted". This module centralises
// both decisions so the main Movimientos cards and the breakdown page always
// agree on the numbers.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  CoinsbuyDepositTx,
  CoinsbuyWithdrawalTx,
  FairpayDepositTx,
  UnipaymentDepositTx,
  PayprosDepositTx,
  ProviderDataset,
  ProviderTotals,
  ProviderTransaction,
} from './types';

/**
 * The status string that counts toward totals for each provider slug.
 *
 * Pay-Pros: 'paid' (código 4 del webhook) es el ÚNICO estado que es plata
 * cobrada. 'payout_paid' (6) es un retiro y tiene su propia constante abajo;
 * refunds, vencidos y payouts rechazados no mueven caja. Mismo criterio que
 * el RPC `get_channel_day_movements` (migración 082), que es quien arma el
 * libro diario del canal: si los dos no coinciden, el libro y la tarjeta
 * cuentan cosas distintas.
 */
export const ACCEPTED_STATUS = {
  'coinsbuy-deposits': 'Confirmed',
  'coinsbuy-withdrawals': 'Approved',
  fairpay: 'Completed',
  unipayment: 'Completed',
  paypros: 'paid',
} as const;

/**
 * Estado de Pay-Pros que representa una SALIDA de plata (payout ejecutado).
 *
 * No entra en `computeProviderTotals`, que devuelve el total del slug tal
 * como se muestra en la fila de Depósitos. Los payouts se cuentan en el libro
 * del canal (RPC 082) y se exponen aparte en `countPayprosPayouts` para que
 * su existencia NUNCA sea silenciosa.
 *
 * CORRECCIÓN 2026-08-31: este comentario decía «hoy Vex Pro tiene 0 filas
 * 'payout_paid'». Era cierto y dejó de serlo el mismo día: el espejo del CRM
 * ahora proyecta los retiros aprobados de Pay-Pros con este status
 * (src/lib/api-integrations/paypros/withdrawals-from-crm.ts — al 2026-08-31,
 * 6 retiros por US$ 2.617,62). El «si aparecen» ya pasó, y por eso
 * `useApiTotals` los suma a Retiros Totales vía `API_WITHDRAWAL_CHANNELS`.
 */
export const PAYPROS_PAYOUT_STATUS = 'payout_paid';

/**
 * Cuántos payouts (salidas) trae el dataset de Pay-Pros y por cuánto.
 * `computeProviderTotals('paypros')` los deja afuera a propósito; esto existe
 * para poder AVISAR de la exclusión en vez de tragársela.
 */
export function countPayprosPayouts(
  dataset: ProviderDataset,
): { count: number; total: number } {
  if (dataset.slug !== 'paypros') return { count: 0, total: 0 };
  const rows = (dataset.transactions as PayprosDepositTx[]).filter(
    (t) => t.status === PAYPROS_PAYOUT_STATUS,
  );
  return {
    count: rows.length,
    total: rows.reduce((s, t) => s + (t.amount ?? 0), 0),
  };
}

/**
 * Filter a dataset's transactions down to only the ones whose status
 * counts for this provider. The breakdown page shows exactly these.
 */
export function acceptedTransactions<T extends ProviderTransaction>(
  dataset: ProviderDataset<T>
): T[] {
  const accepted = ACCEPTED_STATUS[dataset.slug];
  return dataset.transactions.filter(
    (t) => (t as { status: string }).status === accepted
  );
}

/**
 * Compute the headline totals for a provider dataset, respecting each
 * provider's canonical amount field and accepted status.
 */
export function computeProviderTotals(dataset: ProviderDataset): ProviderTotals {
  switch (dataset.slug) {
    case 'coinsbuy-deposits': {
      // Excluimos también las marcadas manualmente como externas (fondeos
      // operativos / swaps) — el admin las flagea desde /movimientos/desglose
      // y no deben contar para los totales del dashboard.
      const rows = (dataset.transactions as CoinsbuyDepositTx[]).filter(
        (t) => t.status === 'Confirmed' && t.excluded !== true
      );
      return {
        total: rows.reduce((s, t) => s + t.amountTarget, 0),
        count: rows.length,
        feeTotal: rows.reduce((s, t) => s + t.commission, 0),
        acceptedStatus: 'Confirmed',
      };
    }
    case 'coinsbuy-withdrawals': {
      // Igual que deposits: excluimos las marcadas manualmente como externas
      // (retiros fuera del flow del CRM / swaps) — el admin las flagea desde
      // /movimientos/desglose y no deben contar para los totales.
      // También excluimos las transferencias INTERNAS (`internal === true`):
      // payouts entre wallets propias de la empresa (txid null en Coinsbuy).
      // Ese dinero nunca salió de la empresa, así que no cuenta en Retiros
      // Totales ni en Net Deposit.
      const rows = (dataset.transactions as CoinsbuyWithdrawalTx[]).filter(
        (t) => t.status === 'Approved' && t.excluded !== true && t.internal !== true
      );
      return {
        total: rows.reduce((s, t) => s + t.chargedAmount, 0),
        count: rows.length,
        feeTotal: rows.reduce((s, t) => s + t.commission, 0),
        acceptedStatus: 'Approved',
      };
    }
    case 'fairpay': {
      const rows = (dataset.transactions as FairpayDepositTx[]).filter(
        (t) => t.status === 'Completed'
      );
      return {
        total: rows.reduce((s, t) => s + t.net, 0),
        count: rows.length,
        feeTotal: rows.reduce((s, t) => s + t.mdr, 0),
        acceptedStatus: 'Completed',
      };
    }
    case 'unipayment': {
      const rows = (dataset.transactions as UnipaymentDepositTx[]).filter(
        (t) => t.status === 'Completed'
      );
      return {
        total: rows.reduce((s, t) => s + t.netAmount, 0),
        count: rows.length,
        feeTotal: rows.reduce((s, t) => s + t.fee, 0),
        acceptedStatus: 'Completed',
      };
    }
    case 'paypros': {
      // Solo 'paid'. Los 'payout_paid' son salidas y NO se restan acá:
      // restarlos de los depósitos escondería un retiro dentro de un número de
      // depósitos. Desde el 2026-08-31 se suman del lado de los RETIROS, por
      // el registro `src/lib/withdrawal-channels.ts` — que es donde
      // correspondía, y no acá. Ver countPayprosPayouts.
      const rows = (dataset.transactions as PayprosDepositTx[]).filter(
        (t) => t.status === 'paid'
      );
      return {
        total: rows.reduce((s, t) => s + (t.amount ?? 0), 0),
        count: rows.length,
        // Pay-Pros no informa comisión: 0 es «no cobra / no lo dice», y así
        // se persiste en api_transactions.fee desde el primer día.
        feeTotal: 0,
        acceptedStatus: 'paid',
      };
    }
  }
}

/**
 * Inclusive date range filter. `from`/`to` are YYYY-MM-DD. Either can be
 * omitted (open-ended range).
 */
export function filterByDateRange<T extends ProviderTransaction>(
  rows: T[],
  from?: string,
  to?: string
): T[] {
  if (!from && !to) return rows;
  const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
  const toTs = to ? new Date(`${to}T23:59:59.999`).getTime() : Infinity;
  return rows.filter((t) => {
    const ts = new Date(t.createdAt).getTime();
    return ts >= fromTs && ts <= toTs;
  });
}

/**
 * Produce a YYYY-MM-DD string for the first and last day of the month that
 * contains the given ISO date (defaults to today).
 */
export function monthRange(yearMonth?: string): { from: string; to: string } {
  const now = yearMonth ? new Date(`${yearMonth}-01T00:00:00`) : new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    from: `${year}-${pad(month + 1)}-${pad(first.getDate())}`,
    to: `${year}-${pad(month + 1)}-${pad(last.getDate())}`,
  };
}
