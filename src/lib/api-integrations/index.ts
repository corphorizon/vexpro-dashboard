// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Public surface
// ─────────────────────────────────────────────────────────────────────────────

export type {
  ProviderId,
  ProviderSlug,
  FetchStatus,
  CoinsbuyDepositTx,
  CoinsbuyWithdrawalTx,
  FairpayDepositTx,
  UnipaymentDepositTx,
  ProviderTransaction,
  ProviderDataset,
  ProviderTotals,
} from './types';

export {
  PROVIDER_CONFIG,
  REFRESH_INTERVAL_MS,
  isProviderEnabled,
} from './config';

export {
  fetchAggregatedMovements,
  fetchProviderBySlug,
} from './aggregator';

export type { AggregatedMovements, FetchOptions } from './aggregator';

export {
  ACCEPTED_STATUS,
  acceptedTransactions,
  computeProviderTotals,
  filterByDateRange,
  monthRange,
} from './totals';

export { fetchCoinsbuyBalance } from './coinsbuy';
