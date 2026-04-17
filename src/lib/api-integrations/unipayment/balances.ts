// ─────────────────────────────────────────────────────────────────────────────
// UniPayment — Wallet Balances service
//
// GET /v1.0/wallet/balances → returns balance per account/asset type
//
// When credentials are not configured, falls back to mock data.
// ─────────────────────────────────────────────────────────────────────────────

import { getUnipaymentToken, isUnipaymentEnabled } from './auth';
import { proxiedFetch } from '../proxy';
import { withRetry } from '../retry';

const UNIPAYMENT_BASE_URL =
  process.env.UNIPAYMENT_BASE_URL ?? 'https://api.unipayment.io';

// ── Public types ───────────────────────────────────────────────────────────

export interface UnipaymentWalletBalance {
  accountId: string;
  assetType: string;
  balance: number;
  availableBalance: number;
}

// ── API response shapes ────────────────────────────────────────────────────

interface BalanceResource {
  id?: string;
  account_id?: string;
  asset_type: string;
  balance: number;
  available_balance?: number;  // some responses use this
  available?: number;          // real API uses this field
  frozen_balance?: number;
  reversed_balance?: number;
}

interface BalancesResponse {
  msg: string;
  code: string;
  data: BalanceResource[];
}

// ── Mock data ──────────────────────────────────────────────────────────────

const MOCK_BALANCES: UnipaymentWalletBalance[] = [
  {
    accountId: 'mock-1',
    assetType: 'USDT',
    balance: 27384.73,
    availableBalance: 27384.73,
  },
];

// ── Main fetch ─────────────────────────────────────────────────────────────

export async function fetchUnipaymentBalances(): Promise<{
  balances: UnipaymentWalletBalance[];
  isMock: boolean;
  fetchedAt: string;
  error?: string;
}> {
  const now = new Date().toISOString();

  if (!isUnipaymentEnabled()) {
    return {
      balances: MOCK_BALANCES,
      isMock: true,
      fetchedAt: now,
    };
  }

  try {
    const token = await getUnipaymentToken();

    const response: BalancesResponse = await withRetry(async () => {
      const res = await proxiedFetch(`${UNIPAYMENT_BASE_URL}/v1.0/wallet/balances`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        throw new Error(
          `UniPayment balances ${res.status}: ${await res.text().catch(() => '')}`,
        );
      }

      return res.json() as Promise<BalancesResponse>;
    });

    const balances: UnipaymentWalletBalance[] = (response.data ?? []).map(
      (b) => ({
        accountId: b.account_id ?? b.id ?? '',
        assetType: b.asset_type,
        balance: Number(b.balance ?? 0),
        availableBalance: Number(b.available ?? b.available_balance ?? 0),
      }),
    );

    return {
      balances,
      isMock: false,
      fetchedAt: now,
    };
  } catch (err) {
    return {
      balances: [],
      isMock: false,
      fetchedAt: now,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
