// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Shared types
//
// Common shapes used by all external API providers (Coinsbuy, FairPay,
// Unipayment, etc.). The Movimientos page consumes ExternalDeposit /
// ExternalWithdrawal regardless of the source provider.
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderId = 'coinsbuy' | 'fairpay' | 'unipayment';

export type FetchStatus = 'fresh' | 'stale' | 'error';

export interface ExternalDeposit {
  id: string;            // provider-prefixed id, e.g. "coinsbuy-tx-1"
  provider: ProviderId;
  date: string;          // ISO date YYYY-MM-DD
  amount: number;
  currency: string;      // 'USD', 'EUR', etc
  customer?: string;     // optional payer / wallet identifier
  status?: string;       // provider-specific status
  raw?: unknown;         // original payload (for debugging)
}

export interface ExternalWithdrawal {
  id: string;
  provider: ProviderId;
  date: string;
  amount: number;
  currency: string;
  destination?: string;
  status?: string;
  raw?: unknown;
}

export interface ProviderResult<T> {
  provider: ProviderId;
  status: FetchStatus;
  data: T[];
  fetchedAt: string;     // ISO timestamp
  errorMessage?: string;
  isMock: boolean;       // true while mocks are in use
}

export interface ApiCredentials {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
}

export interface ProviderConfig {
  enabled: boolean;
  credentials: ApiCredentials;
}
