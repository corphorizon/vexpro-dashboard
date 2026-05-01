// ─────────────────────────────────────────────────────────────────────────────
// Coinsbuy v3 — Shared transfers fetcher
//
// Fetches ALL transfers from GET /transfer/ once (paginated) and splits them
// into deposits (op_type 1) and payouts (op_type 2) client-side. This avoids
// making two identical API calls when the aggregator fetches both.
//
// Accepts optional filters: date range, walletId.
// Only confirmed transfers (status 2) are included.
// ─────────────────────────────────────────────────────────────────────────────

import { getCoinsbuyToken, isCoinsbuyV3Enabled, getCoinsbuyBaseUrl } from './auth';
import { fetchCoinsbuyWallets } from './wallets';
import { proxiedFetch } from '../proxy';
import { withRetry } from '../retry';
import { generateCoinsbuyDeposits } from '../mocks';
import { generateCoinsbuyWithdrawals } from '../mocks';
import { filterByDateRange } from '../totals';
import type {
  CoinsbuyDepositTx,
  CoinsbuyWithdrawalTx,
  ProviderDataset,
} from '../types';

// Per-tenant base URL is resolved at call time via getCoinsbuyBaseUrl().

const PROVIDER = 'coinsbuy' as const;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

// ── JSON:API response shapes ────────────────────────────────────────────────

interface TransferAttributes {
  op_id: number;
  op_type: number;
  amount: string;
  amount_target: string;
  rate_target?: string;
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

// ── Options ─────────────────────────────────────────────────────────────────

export interface TransferFetchOptions {
  from?: string;
  to?: string;
  walletId?: string;
  /** Resolves per-tenant API credentials. Null / undefined → env fallback. */
  companyId?: string | null;
}

// ── Result ──────────────────────────────────────────────────────────────────

export interface CoinsbuyTransferResult {
  deposits: ProviderDataset<CoinsbuyDepositTx>;
  payouts: ProviderDataset<CoinsbuyWithdrawalTx>;
}

// ── Main fetch ──────────────────────────────────────────────────────────────

export async function fetchCoinsbuyTransfers(
  options: TransferFetchOptions = {},
): Promise<CoinsbuyTransferResult> {
  const now = new Date().toISOString();
  const { companyId } = options;

  // No credentials → surface an empty error dataset rather than faking data.
  // This keeps the user from looking at mock numbers and thinking they're
  // real. Set COINSBUY_CLIENT_ID / COINSBUY_CLIENT_SECRET in .env.local to
  // enable the live path (or upload per-tenant creds via superadmin).
  if (!(await isCoinsbuyV3Enabled(companyId))) {
    const error: Pick<ProviderDataset, 'fetchedAt' | 'status' | 'isMock' | 'errorMessage'> = {
      fetchedAt: now,
      status: 'error',
      isMock: false,
      errorMessage: 'Coinsbuy no está configurado (faltan credenciales en el servidor)',
    };
    return {
      deposits: {
        slug: 'coinsbuy-deposits',
        provider: PROVIDER,
        kind: 'deposits',
        transactions: [],
        ...error,
      },
      payouts: {
        slug: 'coinsbuy-withdrawals',
        provider: PROVIDER,
        kind: 'withdrawals',
        transactions: [],
        ...error,
      },
    };
  }

  // Live mode: fetch ALL transfers once, split client-side
  try {
    const token = await getCoinsbuyToken(companyId);
    const baseUrl = await getCoinsbuyBaseUrl(companyId);
    const depositTxs: CoinsbuyDepositTx[] = [];
    const payoutTxs: CoinsbuyWithdrawalTx[] = [];

    // Wallet label lookup: pull the wallet list ONCE up front and build a
    // Map<walletId, label>. Each transfer carries `relationships.wallet.data.id`
    // but no label — without this map the breakdown would show raw numeric
    // wallet IDs ("1079") instead of "VexPro Main Wallet". Failing softly on
    // this lookup is fine — if the wallets endpoint errors we just persist
    // wallet_id without label and the UI falls back to the raw id.
    const walletLabelById = new Map<string, string>();
    try {
      const walletsRes = await fetchCoinsbuyWallets(companyId);
      for (const w of walletsRes.wallets ?? []) {
        if (w.id) walletLabelById.set(String(w.id), w.label ?? '');
      }
    } catch {
      // Silent — wallet labels are best-effort enrichment.
    }

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
            `Coinsbuy v3 transfers ${res.status}: ${errBody.slice(0, 200)}`,
          );
        }

        return res.json() as Promise<TransferListResponse>;
      }, { maxAttempts: 2 });

      for (const transfer of response.data ?? []) {
        const attrs = transfer.attributes;

        // Only confirmed transfers
        if (attrs.status !== 2) continue;

        const walletRelId = transfer.relationships?.wallet?.data?.id ?? undefined;

        // Optional wallet filter
        if (options.walletId) {
          if (walletRelId !== options.walletId) continue;
        }

        // Optional date range filter
        if (options.from && attrs.created_at < `${options.from}T00:00:00`) continue;
        if (options.to && attrs.created_at > `${options.to}T23:59:59`) continue;

        const walletLabel = walletRelId
          ? walletLabelById.get(walletRelId) || undefined
          : undefined;

        if (attrs.op_type === 1) {
          // Deposit
          const amountTarget = Number(attrs.amount_target ?? 0);
          if (amountTarget <= 0) continue;

          depositTxs.push({
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
            walletId: walletRelId,
            walletLabel,
          });
        } else if (attrs.op_type === 2) {
          // Payout
          const amount = Number(attrs.amount ?? 0);
          if (amount <= 0) continue;
          const commission = Number(attrs.commission ?? 0);

          payoutTxs.push({
            id: transfer.id,
            provider: PROVIDER,
            kind: 'withdrawal',
            createdAt: attrs.created_at,
            label: `Withdraw #${attrs.op_id}`,
            trackingId: attrs.txid ?? '',
            amount,
            chargedAmount: amount + commission,
            commission,
            currency: 'USD',
            status: 'Approved',
            walletId: walletRelId,
            walletLabel,
          });
        }
      }

      totalPages = response.meta?.pagination?.pages ?? 1;
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    return {
      deposits: {
        slug: 'coinsbuy-deposits',
        provider: PROVIDER,
        kind: 'deposits',
        transactions: depositTxs,
        fetchedAt: now,
        status: 'fresh',
        isMock: false,
      },
      payouts: {
        slug: 'coinsbuy-withdrawals',
        provider: PROVIDER,
        kind: 'withdrawals',
        transactions: payoutTxs,
        fetchedAt: now,
        status: 'fresh',
        isMock: false,
      },
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    return {
      deposits: {
        slug: 'coinsbuy-deposits',
        provider: PROVIDER,
        kind: 'deposits',
        transactions: [],
        fetchedAt: now,
        status: 'error',
        isMock: false,
        errorMessage,
      },
      payouts: {
        slug: 'coinsbuy-withdrawals',
        provider: PROVIDER,
        kind: 'withdrawals',
        transactions: [],
        fetchedAt: now,
        status: 'error',
        isMock: false,
        errorMessage,
      },
    };
  }
}
