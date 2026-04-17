// ─────────────────────────────────────────────────────────────────────────────
// Unipayment — Deposits service
//
// Real API docs: https://docs.unipayment.io
// Required env vars: UNIPAYMENT_API_KEY, UNIPAYMENT_API_SECRET, UNIPAYMENT_BASE_URL
//
// Accepted status for totals: "Completed". Canonical amount = netAmount.
// ─────────────────────────────────────────────────────────────────────────────

import { PROVIDER_CONFIG, isProviderEnabled } from './config';
import { generateUnipaymentDeposits } from './mocks';
import { withRetry } from './retry';
import { filterByDateRange } from './totals';
import type { UnipaymentDepositTx, ProviderDataset } from './types';

const PROVIDER = 'unipayment' as const;

interface FetchOptions {
  from?: string;
  to?: string;
}

async function callUnipayment(path: string): Promise<unknown> {
  const cfg = PROVIDER_CONFIG[PROVIDER];
  const url = `${cfg.credentials.baseUrl ?? 'https://api.unipayment.io'}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.credentials.apiKey ?? ''}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    throw new Error(`Unipayment ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function fetchUnipaymentDeposits(
  options: FetchOptions = {}
): Promise<ProviderDataset<UnipaymentDepositTx>> {
  const now = new Date().toISOString();

  if (!isProviderEnabled(PROVIDER)) {
    const all = generateUnipaymentDeposits();
    return {
      slug: 'unipayment',
      provider: PROVIDER,
      kind: 'deposits',
      transactions: filterByDateRange(all, options.from, options.to),
      fetchedAt: now,
      status: 'fresh',
      isMock: true,
    };
  }

  try {
    const rows = await withRetry(async () => {
      const qs = new URLSearchParams();
      if (options.from) qs.set('start_date', options.from);
      if (options.to) qs.set('end_date', options.to);
      const json = (await callUnipayment(
        `/v1.0/invoices${qs.toString() ? '?' + qs.toString() : ''}`
      )) as { data?: Array<Record<string, unknown>> };
      return (json.data ?? []).map((item, i): UnipaymentDepositTx => {
        const grossAmount = Number(item.price_amount ?? 0);
        const fee = Number(item.fee ?? 0);
        const netAmount = Number(item.net_amount ?? grossAmount - fee);
        return {
          id: String(item.invoice_id ?? `up-${i}`),
          provider: PROVIDER,
          kind: 'deposit',
          createdAt: String(item.create_date ?? now),
          email: String(item.buyer_email ?? ''),
          orderId: String(item.order_id ?? ''),
          grossAmount,
          fee,
          netAmount,
          currency: String(item.price_currency ?? 'USD'),
          status: (item.status as UnipaymentDepositTx['status']) ?? 'Pending',
        };
      });
    });
    return {
      slug: 'unipayment',
      provider: PROVIDER,
      kind: 'deposits',
      transactions: rows,
      fetchedAt: now,
      status: 'fresh',
      isMock: false,
    };
  } catch (err) {
    return {
      slug: 'unipayment',
      provider: PROVIDER,
      kind: 'deposits',
      transactions: [],
      fetchedAt: now,
      status: 'error',
      isMock: false,
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
