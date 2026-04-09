// ─────────────────────────────────────────────────────────────────────────────
// Coinsbuy — Wallet balance lookup
//
// Transactions (deposits/withdrawals) live in their own files:
//   - coinsbuy-deposits.ts
//   - coinsbuy-withdrawals.ts
//
// This file is kept for the Balances page lookup only.
// ─────────────────────────────────────────────────────────────────────────────

import { PROVIDER_CONFIG, isProviderEnabled } from './config';
import { withRetry } from './retry';

const PROVIDER = 'coinsbuy' as const;

export async function fetchCoinsbuyBalance(): Promise<number | null> {
  if (!isProviderEnabled(PROVIDER)) {
    // Mock balance for development
    return 12500.0;
  }
  return withRetry(async () => {
    const cfg = PROVIDER_CONFIG[PROVIDER];
    const url = `${cfg.credentials.baseUrl ?? 'https://api.coinsbuy.com/v2'}/wallets`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cfg.credentials.apiKey ?? ''}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Coinsbuy balance ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { balance?: number };
    return json.balance ?? null;
  });
}
