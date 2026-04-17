// ─────────────────────────────────────────────────────────────────────────────
// Coinsbuy v3 — Payouts (withdrawals) service
//
// Fetches ALL transfers from GET /transfer/ (no server-side filters since the
// Coinsbuy v3 API may reject unknown filter params). Then filters client-side:
//   • op_type === 2  → payout
//   • status  === 2  → confirmed/approved
//   • amount > 0
//   • optionally by wallet id
//
// charged_amount = amount + commission (what was actually deducted).
// When credentials are not configured, falls back to mock data.
// ─────────────────────────────────────────────────────────────────────────────

import { getCoinsbuyToken, isCoinsbuyV3Enabled } from './auth';
import { proxiedFetch } from '../proxy';
import { withRetry } from '../retry';
import type { CoinsbuyWithdrawalTx, ProviderDataset } from '../types';
import { generateCoinsbuyWithdrawals } from '../mocks';
import { filterByDateRange } from '../totals';

const COINSBUY_BASE_URL =
  process.env.COINSBUY_BASE_URL ?? 'https://v3.api.coinsbuy.com';

const PAGE_SIZE = 100;
const MAX_PAGES = 20; // safety cap

// ── JSON:API response shapes ────────────────────────────────────────────────

interface TransferAttributes {
  op_id: number;
  op_type: number;
  amount: string;
  amount_target: string;
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

export async function fetchCoinsbuyPayoutsV3(
  options: { from?: string; to?: string; walletId?: string } = {},
): Promise<ProviderDataset<CoinsbuyWithdrawalTx>> {
  const now = new Date().toISOString();

  // Mock fallback
  if (!isCoinsbuyV3Enabled()) {
    const all = generateCoinsbuyWithdrawals();
    return {
      slug: 'coinsbuy-withdrawals',
      provider: 'coinsbuy',
      kind: 'withdrawals',
      transactions: filterByDateRange(all, options.from, options.to),
      fetchedAt: now,
      status: 'fresh',
      isMock: true,
    };
  }

  // Live mode: fetch ALL transfers, filter client-side
  try {
    const token = await getCoinsbuyToken();
    const allTransactions: CoinsbuyWithdrawalTx[] = [];

    let page = 1;
    let totalPages = 1;

    do {
      const params = new URLSearchParams();
      params.set('page[size]', String(PAGE_SIZE));
      params.set('page[number]', String(page));
      params.set('ordering', '-created_at');

      const url = `${COINSBUY_BASE_URL}/transfer/?${params.toString()}`;

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
            `Coinsbuy v3 payouts ${res.status}: ${errBody.slice(0, 200)}`,
          );
        }

        return res.json() as Promise<TransferListResponse>;
      }, { maxAttempts: 2 });

      for (const transfer of response.data ?? []) {
        const attrs = transfer.attributes;

        // ── Client-side filters ──
        // Only payouts (op_type 2) that are confirmed (status 2)
        if (attrs.op_type !== 2) continue;
        if (attrs.status !== 2) continue;

        // Optional wallet filter
        if (options.walletId) {
          const walletRelId = transfer.relationships?.wallet?.data?.id;
          if (walletRelId !== options.walletId) continue;
        }

        const amount = Number(attrs.amount ?? 0);
        if (amount <= 0) continue;

        // Optional date range filter
        if (options.from && attrs.created_at < `${options.from}T00:00:00`) continue;
        if (options.to && attrs.created_at > `${options.to}T23:59:59`) continue;

        const commission = Number(attrs.commission ?? 0);
        const chargedAmount = amount + commission;

        allTransactions.push({
          id: transfer.id,
          provider: 'coinsbuy',
          kind: 'withdrawal',
          createdAt: attrs.created_at,
          label: `Withdraw #${attrs.op_id}`,
          trackingId: attrs.txid ?? '',
          amount,
          chargedAmount,
          commission,
          currency: 'USD',
          status: 'Approved',
        });
      }

      totalPages = response.meta?.pagination?.pages ?? 1;
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    return {
      slug: 'coinsbuy-withdrawals',
      provider: 'coinsbuy',
      kind: 'withdrawals',
      transactions: allTransactions,
      fetchedAt: now,
      status: 'fresh',
      isMock: false,
    };
  } catch (err) {
    return {
      slug: 'coinsbuy-withdrawals',
      provider: 'coinsbuy',
      kind: 'withdrawals',
      transactions: [],
      fetchedAt: now,
      status: 'error',
      isMock: false,
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
