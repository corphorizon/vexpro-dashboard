// ─────────────────────────────────────────────────────────────────────────────
// FairPay provider
//
// Mock-first wrapper. Switches to live when FAIRPAY_API_KEY / SECRET are set.
// ─────────────────────────────────────────────────────────────────────────────

import { PROVIDER_CONFIG, isProviderEnabled } from './config';
import { getMockDeposits } from './mocks';
import { withRetry } from './retry';
import type { ExternalDeposit } from './types';

const PROVIDER = 'fairpay' as const;

async function callFairpay(path: string): Promise<unknown> {
  const cfg = PROVIDER_CONFIG[PROVIDER];
  const url = `${cfg.credentials.baseUrl ?? 'https://api.fairpay.com/v1'}${path}`;
  const res = await fetch(url, {
    headers: {
      'X-API-Key': cfg.credentials.apiKey ?? '',
      'X-API-Secret': cfg.credentials.apiSecret ?? '',
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`FairPay ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function fetchFairpayDeposits(): Promise<ExternalDeposit[]> {
  if (!isProviderEnabled(PROVIDER)) {
    return getMockDeposits(PROVIDER);
  }
  return withRetry(async () => {
    const json = (await callFairpay('/transactions?type=incoming')) as { transactions?: unknown[] };
    return (json.transactions ?? []).map((item, i): ExternalDeposit => ({
      id: `fairpay-d-${i}`,
      provider: PROVIDER,
      date: new Date().toISOString().slice(0, 10),
      amount: 0,
      currency: 'USD',
      raw: item,
    }));
  });
}
