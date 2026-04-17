// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Aggregator
//
// Fans out to all provider services in parallel. Each provider already
// returns its own ProviderDataset with inline error handling, so one
// provider failing never breaks the others.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchCoinsbuyTransfers } from './coinsbuy/transfers';
import { fetchCoinsbuyDepositsV3 } from './coinsbuy/deposits';
import { fetchCoinsbuyPayoutsV3 } from './coinsbuy/payouts';
import { fetchFairpayDeposits } from './fairpay/transactions';
import { fetchUnipaymentDepositsV2 } from './unipayment/transactions';
import type { ProviderDataset, ProviderSlug } from './types';

export interface FetchOptions {
  from?: string;
  to?: string;
  walletId?: string;
}

export interface AggregatedMovements {
  datasets: ProviderDataset[];
  fetchedAt: string;
}

export async function fetchAggregatedMovements(
  options: FetchOptions = {}
): Promise<AggregatedMovements> {
  // Use shared transfers fetcher for Coinsbuy (1 API call instead of 2)
  const [coinsbuyResult, fairpay, unipayment] = await Promise.all([
    fetchCoinsbuyTransfers(options),
    fetchFairpayDeposits(options),
    fetchUnipaymentDepositsV2(options),
  ]);
  return {
    datasets: [coinsbuyResult.deposits, coinsbuyResult.payouts, fairpay, unipayment],
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
      return fetchCoinsbuyDepositsV3(options);
    case 'coinsbuy-withdrawals':
      return fetchCoinsbuyPayoutsV3(options);
    case 'fairpay':
      return fetchFairpayDeposits(options);
    case 'unipayment':
      return fetchUnipaymentDepositsV2(options);
  }
}
