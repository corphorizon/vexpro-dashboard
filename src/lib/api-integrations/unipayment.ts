// ─────────────────────────────────────────────────────────────────────────────
// Unipayment provider
//
// Mock-first wrapper. Switches to live when UNIPAYMENT_API_KEY / SECRET set.
// ─────────────────────────────────────────────────────────────────────────────

import { PROVIDER_CONFIG, isProviderEnabled } from './config';
import { getMockDeposits } from './mocks';
import { withRetry } from './retry';
import type { ExternalDeposit } from './types';

const PROVIDER = 'unipayment' as const;

async function callUnipayment(path: string): Promise<unknown> {
  const cfg = PROVIDER_CONFIG[PROVIDER];
  const url = `${cfg.credentials.baseUrl ?? 'https://api.unipayment.io/v1'}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.credentials.apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Unipayment ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function fetchUnipaymentDeposits(): Promise<ExternalDeposit[]> {
  if (!isProviderEnabled(PROVIDER)) {
    return getMockDeposits(PROVIDER);
  }
  return withRetry(async () => {
    const json = (await callUnipayment('/invoices?status=paid')) as { invoices?: unknown[] };
    return (json.invoices ?? []).map((item, i): ExternalDeposit => ({
      id: `unipayment-d-${i}`,
      provider: PROVIDER,
      date: new Date().toISOString().slice(0, 10),
      amount: 0,
      currency: 'USD',
      raw: item,
    }));
  });
}
