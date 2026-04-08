// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Mocks
//
// Stand-in data that simulates the real provider responses. Used while real
// API credentials are not configured. Once credentials are added, the
// providers' real fetch functions take over and these mocks are bypassed.
// ─────────────────────────────────────────────────────────────────────────────

import type { ExternalDeposit, ExternalWithdrawal, ProviderId } from './types';

function todayMinusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ── Coinsbuy mocks ──
export const MOCK_COINSBUY_DEPOSITS: ExternalDeposit[] = [
  { id: 'coinsbuy-d-1', provider: 'coinsbuy', date: todayMinusDays(0), amount: 1250.50, currency: 'USD', customer: 'wallet-9af2', status: 'completed' },
  { id: 'coinsbuy-d-2', provider: 'coinsbuy', date: todayMinusDays(1), amount: 480.00,  currency: 'USD', customer: 'wallet-3e1c', status: 'completed' },
  { id: 'coinsbuy-d-3', provider: 'coinsbuy', date: todayMinusDays(2), amount: 2100.75, currency: 'USD', customer: 'wallet-7b88', status: 'completed' },
];

export const MOCK_COINSBUY_WITHDRAWALS: ExternalWithdrawal[] = [
  { id: 'coinsbuy-w-1', provider: 'coinsbuy', date: todayMinusDays(0), amount: 800.00,  currency: 'USD', destination: 'wallet-out-aa', status: 'completed' },
  { id: 'coinsbuy-w-2', provider: 'coinsbuy', date: todayMinusDays(3), amount: 1500.00, currency: 'USD', destination: 'wallet-out-bb', status: 'completed' },
];

// ── FairPay mocks ──
export const MOCK_FAIRPAY_DEPOSITS: ExternalDeposit[] = [
  { id: 'fairpay-d-1', provider: 'fairpay', date: todayMinusDays(0), amount: 350.00, currency: 'USD', customer: 'cust-001', status: 'paid' },
  { id: 'fairpay-d-2', provider: 'fairpay', date: todayMinusDays(1), amount: 720.00, currency: 'USD', customer: 'cust-002', status: 'paid' },
];

// ── Unipayment mocks ──
export const MOCK_UNIPAYMENT_DEPOSITS: ExternalDeposit[] = [
  { id: 'unipayment-d-1', provider: 'unipayment', date: todayMinusDays(0), amount: 510.00, currency: 'USD', customer: 'card-***1234', status: 'success' },
  { id: 'unipayment-d-2', provider: 'unipayment', date: todayMinusDays(2), amount: 290.00, currency: 'USD', customer: 'card-***5678', status: 'success' },
];

export function getMockDeposits(provider: ProviderId): ExternalDeposit[] {
  switch (provider) {
    case 'coinsbuy':   return MOCK_COINSBUY_DEPOSITS;
    case 'fairpay':    return MOCK_FAIRPAY_DEPOSITS;
    case 'unipayment': return MOCK_UNIPAYMENT_DEPOSITS;
  }
}

export function getMockWithdrawals(provider: ProviderId): ExternalWithdrawal[] {
  switch (provider) {
    case 'coinsbuy': return MOCK_COINSBUY_WITHDRAWALS;
    default:         return [];
  }
}
