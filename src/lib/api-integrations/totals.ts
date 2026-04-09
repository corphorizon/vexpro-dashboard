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
  ProviderDataset,
  ProviderTotals,
  ProviderTransaction,
} from './types';

/**
 * The status string that counts toward totals for each provider slug.
 */
export const ACCEPTED_STATUS = {
  'coinsbuy-deposits': 'Confirmed',
  'coinsbuy-withdrawals': 'Approved',
  fairpay: 'Completed',
  unipayment: 'Completed',
} as const;

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
      const rows = (dataset.transactions as CoinsbuyDepositTx[]).filter(
        (t) => t.status === 'Confirmed'
      );
      return {
        total: rows.reduce((s, t) => s + t.amountTarget, 0),
        count: rows.length,
        feeTotal: rows.reduce((s, t) => s + t.commission, 0),
        acceptedStatus: 'Confirmed',
      };
    }
    case 'coinsbuy-withdrawals': {
      const rows = (dataset.transactions as CoinsbuyWithdrawalTx[]).filter(
        (t) => t.status === 'Approved'
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
