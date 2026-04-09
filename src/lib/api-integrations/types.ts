// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Shared types
//
// Per-provider transaction shapes that match the columns each provider
// returns in its real API response. The breakdown page (/movimientos/desglose)
// renders these directly; the main Movimientos page uses `computeProviderTotals`
// to get the filtered sum that corresponds to each provider's "accepted" status.
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderId = 'coinsbuy' | 'fairpay' | 'unipayment';
export type FetchStatus = 'fresh' | 'stale' | 'error';

/**
 * Stable slug used in the URL for the breakdown page and in API query params.
 * One slug per card shown on the Movimientos page.
 */
export type ProviderSlug =
  | 'coinsbuy-deposits'
  | 'coinsbuy-withdrawals'
  | 'fairpay'
  | 'unipayment';

// ── Coinsbuy ──

export interface CoinsbuyDepositTx {
  id: string;
  provider: 'coinsbuy';
  kind: 'deposit';
  createdAt: string;       // ISO datetime
  label: string;
  trackingId: string;
  commission: number;      // fee charged by Coinsbuy
  amountTarget: number;    // net amount credited (what we sum for totals)
  currency: string;
  status: 'Confirmed' | 'Pending' | 'Failed';
}

export interface CoinsbuyWithdrawalTx {
  id: string;
  provider: 'coinsbuy';
  kind: 'withdrawal';
  createdAt: string;
  label: string;
  trackingId: string;
  amount: number;          // requested amount
  chargedAmount: number;   // amount actually deducted (what we sum for totals)
  commission: number;      // chargedAmount - amount (precomputed)
  currency: string;
  status: 'Approved' | 'Pending' | 'Rejected';
}

// ── FairPay ──

export interface FairpayDepositTx {
  id: string;
  provider: 'fairpay';
  kind: 'deposit';
  createdAt: string;
  customerEmail: string;
  billed: number;          // gross amount
  mdr: number;             // merchant discount rate (fee)
  net: number;             // billed - mdr (what we sum for totals)
  currency: string;
  status: 'Completed' | 'Pending' | 'Failed';
}

// ── Unipayment ──

export interface UnipaymentDepositTx {
  id: string;
  provider: 'unipayment';
  kind: 'deposit';
  createdAt: string;
  email: string;
  orderId: string;
  grossAmount: number;
  fee: number;
  netAmount: number;       // what we sum for totals
  currency: string;
  status: 'Completed' | 'Pending' | 'Expired';
}

// ── Union + dataset ──

export type ProviderTransaction =
  | CoinsbuyDepositTx
  | CoinsbuyWithdrawalTx
  | FairpayDepositTx
  | UnipaymentDepositTx;

export interface ProviderDataset<T extends ProviderTransaction = ProviderTransaction> {
  slug: ProviderSlug;
  provider: ProviderId;
  kind: 'deposits' | 'withdrawals';
  transactions: T[];       // ALL rows (unfiltered) — filter happens in totals helper
  fetchedAt: string;       // ISO timestamp
  status: FetchStatus;
  isMock: boolean;
  errorMessage?: string;
}

// ── Totals (filtered by accepted status) ──

export interface ProviderTotals {
  total: number;           // sum of the canonical amount field
  count: number;           // count of accepted transactions
  feeTotal: number;        // sum of fees / commissions
  acceptedStatus: string;  // label of the status we count
}

// ── Config ──

export interface ApiCredentials {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
}

export interface ProviderConfig {
  enabled: boolean;
  credentials: ApiCredentials;
}
