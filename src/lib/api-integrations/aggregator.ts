// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Aggregator
//
// Calls all enabled providers in parallel and returns a unified
// ProviderResult per source. Failures in one provider DO NOT break others;
// the failing provider returns status: 'error' with the last known data
// (empty if first call).
// ─────────────────────────────────────────────────────────────────────────────

import { fetchCoinsbuyDeposits, fetchCoinsbuyWithdrawals } from './coinsbuy';
import { fetchFairpayDeposits } from './fairpay';
import { fetchUnipaymentDeposits } from './unipayment';
import { isProviderEnabled } from './config';
import type {
  ExternalDeposit,
  ExternalWithdrawal,
  ProviderId,
  ProviderResult,
} from './types';

function makeOk<T>(provider: ProviderId, data: T[]): ProviderResult<T> {
  return {
    provider,
    status: 'fresh',
    data,
    fetchedAt: new Date().toISOString(),
    isMock: !isProviderEnabled(provider),
  };
}

function makeError<T>(provider: ProviderId, err: unknown, fallback: T[] = []): ProviderResult<T> {
  return {
    provider,
    status: 'error',
    data: fallback,
    fetchedAt: new Date().toISOString(),
    errorMessage: err instanceof Error ? err.message : 'Unknown error',
    isMock: !isProviderEnabled(provider),
  };
}

// ── Aggregate deposits from ALL providers ──
export async function fetchAllExternalDeposits(): Promise<ProviderResult<ExternalDeposit>[]> {
  const settlements = await Promise.allSettled([
    fetchCoinsbuyDeposits(),
    fetchFairpayDeposits(),
    fetchUnipaymentDeposits(),
  ]);

  const providers: ProviderId[] = ['coinsbuy', 'fairpay', 'unipayment'];

  return settlements.map((s, i) =>
    s.status === 'fulfilled' ? makeOk(providers[i], s.value) : makeError(providers[i], s.reason)
  );
}

// ── Aggregate withdrawals (only Coinsbuy for now) ──
export async function fetchAllExternalWithdrawals(): Promise<ProviderResult<ExternalWithdrawal>[]> {
  const settlements = await Promise.allSettled([
    fetchCoinsbuyWithdrawals(),
  ]);

  const providers: ProviderId[] = ['coinsbuy'];

  return settlements.map((s, i) =>
    s.status === 'fulfilled' ? makeOk(providers[i], s.value) : makeError(providers[i], s.reason)
  );
}

// ── Convenience helpers for the UI ──

export interface AggregatedMovements {
  deposits: ProviderResult<ExternalDeposit>[];
  withdrawals: ProviderResult<ExternalWithdrawal>[];
  fetchedAt: string;
}

export async function fetchAggregatedMovements(): Promise<AggregatedMovements> {
  const [deposits, withdrawals] = await Promise.all([
    fetchAllExternalDeposits(),
    fetchAllExternalWithdrawals(),
  ]);
  return {
    deposits,
    withdrawals,
    fetchedAt: new Date().toISOString(),
  };
}
