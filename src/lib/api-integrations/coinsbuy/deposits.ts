// ─────────────────────────────────────────────────────────────────────────────
// Coinsbuy v3 — Deposits service
//
// Fetches ALL transfers from GET /transfer/ (no server-side filters since the
// Coinsbuy v3 API may reject unknown filter params). Then filters client-side:
//   • op_type === 1  → deposit
//   • status  === 2  → confirmed
//   • amount_target > 0
//   • optionally by wallet id
//
// When credentials are not configured, falls back to mock data.
// ─────────────────────────────────────────────────────────────────────────────

import { getCoinsbuyToken, isCoinsbuyV3Enabled, getCoinsbuyBaseUrl } from './auth';
import { proxiedFetch } from '../proxy';
import { withRetry } from '../retry';
import { generateCoinsbuyDeposits } from '../mocks';
import { filterByDateRange } from '../totals';
import type { CoinsbuyDepositTx, ProviderDataset } from '../types';

// Per-tenant base URL is resolved at call time via getCoinsbuyBaseUrl().
// A module-level const would freeze to env at import time and break
// per-tenant base_url overrides.

const PROVIDER = 'coinsbuy' as const;
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // safety cap

// ── JSON:API response shapes ────────────────────────────────────────────────

interface TransferAttributes {
  op_id: number;
  op_type: number;
  amount: string;
  amount_target: string;
  rate_target: string;
  commission: string;
  fee: string;
  txid: string;
  status: number;
  created_at: string;
  updated_at: string;
}

interface TransferResource {
  id: string;
  type: string;
  attributes: TransferAttributes;
  relationships?: {
    currency?: { data: { type: string; id: string } };
    wallet?: { data: { type: string; id: string } };
    parent?: { data: { type: string; id: string } };
  };
}

interface TransferListResponse {
  data: TransferResource[];
  meta: {
    pagination: {
      page: number;
      pages: number;
      count: number;
    };
  };
}

// ── Main fetch ──────────────────────────────────────────────────────────────

export async function fetchCoinsbuyDepositsV3(
  options: { from?: string; to?: string; walletId?: string; companyId?: string | null } = {},
): Promise<ProviderDataset<CoinsbuyDepositTx>> {
  const now = new Date().toISOString();
  const { companyId } = options;

  // Mock mode
  if (!(await isCoinsbuyV3Enabled(companyId))) {
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

  // Live mode: fetch ALL transfers, filter client-side
  try {
    const token = await getCoinsbuyToken(companyId);
    const baseUrl = await getCoinsbuyBaseUrl(companyId);
    const allTransactions: CoinsbuyDepositTx[] = [];

    let page = 1;
    let totalPages = 1;

    do {
      const params = new URLSearchParams();
      params.set('page[size]', String(PAGE_SIZE));
      params.set('page[number]', String(page));
      params.set('ordering', '-created_at');

      const url = `${baseUrl}/transfer/?${params.toString()}`;

      const response: TransferListResponse = await withRetry(async () => {
        const res = await proxiedFetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/vnd.api+json',
          },
          signal: AbortSignal.timeout(12_000),
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          throw new Error(
            `Coinsbuy v3 deposits ${res.status}: ${errBody.slice(0, 200)}`,
          );
        }

        return res.json() as Promise<TransferListResponse>;
      }, { maxAttempts: 2 });

      for (const transfer of response.data ?? []) {
        const attrs = transfer.attributes;

        // ── Client-side filters ──
        // Only deposits (op_type 1) that are confirmed (status 2)
        if (attrs.op_type !== 1) continue;
        if (attrs.status !== 2) continue;

        // Optional wallet filter
        if (options.walletId) {
          const walletRelId = transfer.relationships?.wallet?.data?.id;
          if (walletRelId !== options.walletId) continue;
        }

        const amountTarget = Number(attrs.amount_target ?? 0);
        if (amountTarget <= 0) continue;

        // Optional date range filter
        if (options.from && attrs.created_at < `${options.from}T00:00:00`) continue;
        if (options.to && attrs.created_at > `${options.to}T23:59:59`) continue;

        allTransactions.push({
          id: transfer.id,
          provider: PROVIDER,
          kind: 'deposit',
          createdAt: attrs.created_at,
          label: `Deposit #${attrs.op_id}`,
          trackingId: attrs.txid ?? '',
          commission: Number(attrs.commission ?? 0),
          amountTarget,
          currency: 'USD',
          status: 'Confirmed',
        });
      }

      totalPages = response.meta?.pagination?.pages ?? 1;
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    return {
      slug: 'coinsbuy-deposits',
      provider: PROVIDER,
      kind: 'deposits',
      transactions: allTransactions,
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
