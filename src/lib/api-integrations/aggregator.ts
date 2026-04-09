// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Aggregator
//
// Fans out to all provider services in parallel. Each provider already
// returns its own ProviderDataset with inline error handling, so one
// provider failing never breaks the others.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchCoinsbuyDeposits } from './coinsbuy-deposits';
import { fetchCoinsbuyWithdrawals } from './coinsbuy-withdrawals';
import { fetchFairpayDeposits } from './fairpay';
import { fetchUnipaymentDeposits } from './unipayment';
import type { ProviderDataset, ProviderSlug } from './types';

export interface FetchOptions {
  from?: string;
  to?: string;
}

export interface AggregatedMovements {
  datasets: ProviderDataset[];
  fetchedAt: string;
}

export async function fetchAggregatedMovements(
  options: FetchOptions = {}
): Promise<AggregatedMovements> {
  const [coinsbuyDeposits, coinsbuyWithdrawals, fairpay, unipayment] = await Promise.all([
    fetchCoinsbuyDeposits(options),
    fetchCoinsbuyWithdrawals(options),
    fetchFairpayDeposits(options),
    fetchUnipaymentDeposits(options),
  ]);
  return {
    datasets: [coinsbuyDeposits, coinsbuyWithdrawals, fairpay, unipayment],
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch a single dataset by slug. Used by the breakdown page.
 */
export async function fetchProviderBySlug(
  slug: ProviderSlug,
  options: FetchOptions = {}
): Promise<ProviderDataset> {
  switch (slug) {
    case 'coinsbuy-deposits':
      return fetchCoinsbuyDeposits(options);
    case 'coinsbuy-withdrawals':
      return fetchCoinsbuyWithdrawals(options);
    case 'fairpay':
      return fetchFairpayDeposits(options);
    case 'unipayment':
      return fetchUnipaymentDeposits(options);
  }
}
