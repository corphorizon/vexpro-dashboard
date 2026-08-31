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
  /**
   * Tenant whose API credentials should be used to authenticate against
   * the upstream provider. REQUIRED for production calls — without it,
   * resolveConfig() correctly refuses to fall back to env credentials
   * (which would leak cross-tenant). Was missing here from the start of
   * the multi-tenant migration and made the live "Refrescar" button in
   * /movimientos always return `status='error', errorMessage='not
   * configured'` (Kevin caught it in the 2026-06-06 code review).
   */
  companyId?: string | null;
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
    case 'paypros':
      // Pay-Pros NO tiene endpoint de listado (ni webhook ni CRM son "fetch"):
      // sus filas llegan por push / por el espejo del CRM y se leen desde
      // api_transactions. Devolvemos un dataset en error explícito en vez de
      // un array vacío: vacío se lee como «no hubo movimientos» y esto es
      // «no se pregunta por acá». La pantalla lee /persisted-movements.
      return {
        slug: 'paypros',
        provider: 'paypros',
        kind: 'deposits',
        transactions: [],
        fetchedAt: new Date().toISOString(),
        status: 'error',
        isMock: false,
        errorMessage:
          'Pay-Pros no expone endpoint de listado: los movimientos se leen del espejo (api_transactions), no de una llamada en vivo.',
      };
  }
}
