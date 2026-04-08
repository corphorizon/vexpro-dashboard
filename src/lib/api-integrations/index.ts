// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Public surface
//
// Single import path for the rest of the app:
//   import { fetchAggregatedMovements, REFRESH_INTERVAL_MS } from '@/lib/api-integrations';
// ─────────────────────────────────────────────────────────────────────────────

export type {
  ProviderId,
  FetchStatus,
  ExternalDeposit,
  ExternalWithdrawal,
  ProviderResult,
} from './types';

export {
  PROVIDER_CONFIG,
  REFRESH_INTERVAL_MS,
  isProviderEnabled,
} from './config';

export {
  fetchAllExternalDeposits,
  fetchAllExternalWithdrawals,
  fetchAggregatedMovements,
} from './aggregator';

export type { AggregatedMovements } from './aggregator';

export { fetchCoinsbuyBalance } from './coinsbuy';
