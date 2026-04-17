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
export { fetchCoinsbuyWallets, type CoinsbuyWallet } from './coinsbuy/wallets';
export { fetchCoinsbuyDepositsV3 } from './coinsbuy/deposits';
export { fetchCoinsbuyPayoutsV3 } from './coinsbuy/payouts';
export { fetchCoinsbuyTransfers } from './coinsbuy/transfers';
export type { CoinsbuyTransferResult, TransferFetchOptions } from './coinsbuy/transfers';

export { fetchUnipaymentDepositsV2 } from './unipayment/transactions';
export { fetchUnipaymentBalances, type UnipaymentWalletBalance } from './unipayment/balances';
export { isUnipaymentEnabled } from './unipayment/auth';
