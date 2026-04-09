// ─────────────────────────────────────────────────────────────────────────────
// Coinsbuy — Deposits service
//
// Real API docs: https://docs.coinsbuy.com
// Required env vars (server-only, never hardcode):
//   COINSBUY_API_KEY, COINSBUY_API_SECRET, COINSBUY_BASE_URL
//
// While credentials are missing, `generateCoinsbuyDeposits()` mocks are used.
// The filtered total (Status = "Confirmed") is computed downstream via
// `computeProviderTotals(dataset)` so UI cards and the breakdown page agree.
// ─────────────────────────────────────────────────────────────────────────────

import { PROVIDER_CONFIG, isProviderEnabled } from './config';
import { generateCoinsbuyDeposits } from './mocks';
import { withRetry } from './retry';
import { filterByDateRange } from './totals';
import type { CoinsbuyDepositTx, ProviderDataset } from './types';

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
    throw new Error(`Coinsbuy deposits ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function fetchCoinsbuyDeposits(
  options: FetchOptions = {}
): Promise<ProviderDataset<CoinsbuyDepositTx>> {
  const now = new Date().toISOString();

  // Mock mode: return generated rows filtered by the requested range.
  if (!isProviderEnabled(PROVIDER)) {
    const all = generateCoinsbuyDeposits();
    return {
      slug: 'coinsbuy-deposits',
      provider: PROVIDER,
      kind: 'deposits',
      transactions: filterByDateRange(all, options.from, options.to),
      fetchedAt: now,
      status: 'fresh',
      isMock: true,
    };
  }

  // Live mode (to be wired when credentials land). The shape below is a
  // placeholder that should be adjusted once the real response is confirmed.
  try {
    const rows = await withRetry(async () => {
      const qs = new URLSearchParams();
      if (options.from) qs.set('from', options.from);
      if (options.to) qs.set('to', options.to);
      const json = (await callCoinsbuy(
        `/payments?type=deposit${qs.toString() ? '&' + qs.toString() : ''}`
      )) as { data?: Array<Record<string, unknown>> };
      return (json.data ?? []).map((item, i): CoinsbuyDepositTx => ({
        id: String(item.id ?? `cb-d-${i}`),
        provider: PROVIDER,
        kind: 'deposit',
        createdAt: String(item.created_at ?? now),
        label: String(item.label ?? ''),
        trackingId: String(item.tracking_id ?? ''),
        commission: Number(item.commission ?? 0),
        amountTarget: Number(item.amount_target ?? 0),
        currency: String(item.currency ?? 'USD'),
        status: (item.status as CoinsbuyDepositTx['status']) ?? 'Pending',
      }));
    });
    return {
      slug: 'coinsbuy-deposits',
      provider: PROVIDER,
      kind: 'deposits',
      transactions: rows,
      fetchedAt: now,
      status: 'fresh',
      isMock: false,
    };
  } catch (err) {
    return {
      slug: 'coinsbuy-deposits',
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
