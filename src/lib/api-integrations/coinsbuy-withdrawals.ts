// ─────────────────────────────────────────────────────────────────────────────
// Coinsbuy — Withdrawals (payouts) service
//
// Real API docs: https://docs.coinsbuy.com/#payouts
// Required env vars: COINSBUY_API_KEY, COINSBUY_API_SECRET, COINSBUY_BASE_URL
//
// Accepted status for totals: "Approved".
// The commission shown in the breakdown table is computed as:
//   commission = chargedAmount - amount
// (the real API already returns both fields, we preserve that convention).
// ─────────────────────────────────────────────────────────────────────────────

import { PROVIDER_CONFIG, isProviderEnabled } from './config';
import { generateCoinsbuyWithdrawals } from './mocks';
import { withRetry } from './retry';
import { filterByDateRange } from './totals';
import type { CoinsbuyWithdrawalTx, ProviderDataset } from './types';

const PROVIDER = 'coinsbuy' as const;

interface FetchOptions {
  from?: string;
  to?: string;
}

async function callCoinsbuy(path: string): Promise<unknown> {
  const cfg = PROVIDER_CONFIG[PROVIDER];
  const url = `${cfg.credentials.baseUrl ?? 'https://api.coinsbuy.com/v2'}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.credentials.apiKey ?? ''}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Coinsbuy withdrawals ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function fetchCoinsbuyWithdrawals(
  options: FetchOptions = {}
): Promise<ProviderDataset<CoinsbuyWithdrawalTx>> {
  const now = new Date().toISOString();

  if (!isProviderEnabled(PROVIDER)) {
    const all = generateCoinsbuyWithdrawals();
    return {
      slug: 'coinsbuy-withdrawals',
      provider: PROVIDER,
      kind: 'withdrawals',
      transactions: filterByDateRange(all, options.from, options.to),
      fetchedAt: now,
      status: 'fresh',
      isMock: true,
    };
  }

  try {
    const rows = await withRetry(async () => {
      const qs = new URLSearchParams();
      if (options.from) qs.set('from', options.from);
      if (options.to) qs.set('to', options.to);
      const json = (await callCoinsbuy(
        `/payouts${qs.toString() ? '?' + qs.toString() : ''}`
      )) as { data?: Array<Record<string, unknown>> };
      return (json.data ?? []).map((item, i): CoinsbuyWithdrawalTx => {
        const amount = Number(item.amount ?? 0);
        const chargedAmount = Number(item.charged_amount ?? amount);
        return {
          id: String(item.id ?? `cb-w-${i}`),
          provider: PROVIDER,
          kind: 'withdrawal',
          createdAt: String(item.created_at ?? now),
          label: String(item.label ?? ''),
          trackingId: String(item.tracking_id ?? ''),
          amount,
          chargedAmount,
          commission: Math.max(0, chargedAmount - amount),
          currency: String(item.currency ?? 'USD'),
          status: (item.status as CoinsbuyWithdrawalTx['status']) ?? 'Pending',
        };
      });
    });
    return {
      slug: 'coinsbuy-withdrawals',
      provider: PROVIDER,
      kind: 'withdrawals',
      transactions: rows,
      fetchedAt: now,
      status: 'fresh',
      isMock: false,
    };
  } catch (err) {
    return {
      slug: 'coinsbuy-withdrawals',
      provider: PROVIDER,
      kind: 'withdrawals',
      transactions: [],
      fetchedAt: now,
      status: 'error',
      isMock: false,
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
