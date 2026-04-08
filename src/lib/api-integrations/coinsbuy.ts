// ─────────────────────────────────────────────────────────────────────────────
// Coinsbuy provider
//
// Real API docs: https://docs.coinsbuy.com (sandbox + production)
//
// While COINSBUY_API_KEY / COINSBUY_API_SECRET are not set, this module
// returns mock data so the rest of the app can be developed and tested.
// To switch to live mode, set the env vars and the wrapper will detect them
// automatically.
// ─────────────────────────────────────────────────────────────────────────────

import { PROVIDER_CONFIG, isProviderEnabled } from './config';
import { getMockDeposits, getMockWithdrawals } from './mocks';
import { withRetry } from './retry';
import type { ExternalDeposit, ExternalWithdrawal } from './types';

const PROVIDER = 'coinsbuy' as const;

// ── Real API call (placeholder — will be wired when credentials arrive) ──
async function callCoinsbuy(path: string): Promise<unknown> {
  const cfg = PROVIDER_CONFIG[PROVIDER];
  const url = `${cfg.credentials.baseUrl ?? 'https://api.coinsbuy.com/v2'}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.credentials.apiKey}`,
      'Content-Type': 'application/json',
    },
    // 30s timeout via AbortSignal
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Coinsbuy ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function fetchCoinsbuyDeposits(): Promise<ExternalDeposit[]> {
  if (!isProviderEnabled(PROVIDER)) {
    return getMockDeposits(PROVIDER);
  }
  return withRetry(async () => {
    const json = (await callCoinsbuy('/payments?type=deposit')) as { data?: unknown[] };
    // TODO: map real response to ExternalDeposit shape when API contract confirmed
    return (json.data ?? []).map((item, i): ExternalDeposit => ({
      id: `coinsbuy-d-${i}`,
      provider: PROVIDER,
      date: new Date().toISOString().slice(0, 10),
      amount: 0,
      currency: 'USD',
      raw: item,
    }));
  });
}

export async function fetchCoinsbuyWithdrawals(): Promise<ExternalWithdrawal[]> {
  if (!isProviderEnabled(PROVIDER)) {
    return getMockWithdrawals(PROVIDER);
  }
  return withRetry(async () => {
    const json = (await callCoinsbuy('/payouts')) as { data?: unknown[] };
    return (json.data ?? []).map((item, i): ExternalWithdrawal => ({
      id: `coinsbuy-w-${i}`,
      provider: PROVIDER,
      date: new Date().toISOString().slice(0, 10),
      amount: 0,
      currency: 'USD',
      raw: item,
    }));
  });
}

// ── Balance lookup (used by Balances page when API ready) ──
export async function fetchCoinsbuyBalance(): Promise<number | null> {
  if (!isProviderEnabled(PROVIDER)) {
    // Mock balance for development
    return 12500.00;
  }
  return withRetry(async () => {
    const json = (await callCoinsbuy('/wallets')) as { balance?: number };
    return json.balance ?? null;
  });
}
