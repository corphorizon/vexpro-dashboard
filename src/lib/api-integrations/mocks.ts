// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Mock data generators
//
// Deterministic pseudo-random data that mirrors each provider's real response
// shape. Exactly 160 records per provider so pagination (100/page) can be
// exercised. Dates span the last 90 days so the date-range filter has room.
//
// Determinism: a simple LCG seeded per-provider keeps the data stable across
// reloads during development — no "flickering" rows in the UI.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  CoinsbuyDepositTx,
  CoinsbuyWithdrawalTx,
  FairpayDepositTx,
  UnipaymentDepositTx,
} from './types';

const MOCK_COUNT = 160;
const DAYS_BACK = 90;

// ── Deterministic PRNG ──
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 0x100000000;
    return s / 0x100000000;
  };
}

function formatDate(daysAgo: number, hour: number, minute: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pick<T>(arr: T[], idx: number): T {
  return arr[idx % arr.length];
}

// Weighted status: ~85% accepted, ~10% pending, ~5% failed.
function weightedStatus<T extends string>(rand: number, accepted: T, pending: T, failed: T): T {
  if (rand < 0.85) return accepted;
  if (rand < 0.95) return pending;
  return failed;
}

// ── Coinsbuy deposits ──

const COINSBUY_LABELS = [
  'Wallet-TRC20-9af2', 'Wallet-ERC20-3e1c', 'Wallet-BTC-7b88',
  'Wallet-TRC20-ff12', 'Wallet-ERC20-a455', 'Wallet-BTC-2dde',
];

export function generateCoinsbuyDeposits(): CoinsbuyDepositTx[] {
  const rand = seededRandom(101);
  const rows: CoinsbuyDepositTx[] = [];
  for (let i = 0; i < MOCK_COUNT; i++) {
    const daysAgo = Math.floor(rand() * DAYS_BACK);
    const hour = Math.floor(rand() * 24);
    const minute = Math.floor(rand() * 60);
    const gross = round2(50 + rand() * 2950);
    const commission = round2(gross * (0.005 + rand() * 0.015));
    const amountTarget = round2(gross - commission);
    const status = weightedStatus(rand(), 'Confirmed', 'Pending', 'Failed') as CoinsbuyDepositTx['status'];
    rows.push({
      id: `cb-d-${String(i + 1).padStart(4, '0')}`,
      provider: 'coinsbuy',
      kind: 'deposit',
      createdAt: formatDate(daysAgo, hour, minute),
      label: pick(COINSBUY_LABELS, i),
      trackingId: `CB-${String(1_000_000 + i).slice(-7)}`,
      commission,
      amountTarget,
      currency: 'USD',
      status,
    });
  }
  return rows;
}

// ── Coinsbuy withdrawals ──

export function generateCoinsbuyWithdrawals(): CoinsbuyWithdrawalTx[] {
  const rand = seededRandom(202);
  const rows: CoinsbuyWithdrawalTx[] = [];
  for (let i = 0; i < MOCK_COUNT; i++) {
    const daysAgo = Math.floor(rand() * DAYS_BACK);
    const hour = Math.floor(rand() * 24);
    const minute = Math.floor(rand() * 60);
    const amount = round2(100 + rand() * 4900);
    const commission = round2(amount * (0.004 + rand() * 0.012));
    const chargedAmount = round2(amount + commission);
    const status = weightedStatus(rand(), 'Approved', 'Pending', 'Rejected') as CoinsbuyWithdrawalTx['status'];
    rows.push({
      id: `cb-w-${String(i + 1).padStart(4, '0')}`,
      provider: 'coinsbuy',
      kind: 'withdrawal',
      createdAt: formatDate(daysAgo, hour, minute),
      label: pick(COINSBUY_LABELS, i + 3),
      trackingId: `CBW-${String(2_000_000 + i).slice(-7)}`,
      amount,
      chargedAmount,
      commission,
      currency: 'USD',
      status,
    });
  }
  return rows;
}

// ── FairPay ──

const FAIRPAY_EMAILS = [
  'carlos.r@example.com', 'maria.lopez@example.com', 'juan.p@example.com',
  'ana.gomez@example.com', 'diego.s@example.com', 'laura.m@example.com',
  'roberto.c@example.com', 'sofia.v@example.com',
];

export function generateFairpayDeposits(): FairpayDepositTx[] {
  const rand = seededRandom(303);
  const rows: FairpayDepositTx[] = [];
  for (let i = 0; i < MOCK_COUNT; i++) {
    const daysAgo = Math.floor(rand() * DAYS_BACK);
    const hour = Math.floor(rand() * 24);
    const minute = Math.floor(rand() * 60);
    const billed = round2(100 + rand() * 3900);
    const mdr = round2(billed * (0.025 + rand() * 0.015));
    const net = round2(billed - mdr);
    const status = weightedStatus(rand(), 'Completed', 'Pending', 'Failed') as FairpayDepositTx['status'];
    rows.push({
      id: `fp-${String(3_000_000 + i).slice(-7)}`,
      provider: 'fairpay',
      kind: 'deposit',
      createdAt: formatDate(daysAgo, hour, minute),
      customerEmail: pick(FAIRPAY_EMAILS, i),
      billed,
      mdr,
      net,
      currency: 'USD',
      status,
    });
  }
  return rows;
}

// ── Unipayment ──

const UNIPAYMENT_EMAILS = [
  'trader01@mail.com', 'trader02@mail.com', 'trader03@mail.com',
  'client.a@mail.com', 'client.b@mail.com', 'client.c@mail.com',
  'user.x@mail.com', 'user.y@mail.com',
];

export function generateUnipaymentDeposits(): UnipaymentDepositTx[] {
  const rand = seededRandom(404);
  const rows: UnipaymentDepositTx[] = [];
  for (let i = 0; i < MOCK_COUNT; i++) {
    const daysAgo = Math.floor(rand() * DAYS_BACK);
    const hour = Math.floor(rand() * 24);
    const minute = Math.floor(rand() * 60);
    const grossAmount = round2(50 + rand() * 2450);
    const fee = round2(grossAmount * (0.01 + rand() * 0.02));
    const netAmount = round2(grossAmount - fee);
    const status = weightedStatus(rand(), 'Completed', 'Pending', 'Expired') as UnipaymentDepositTx['status'];
    rows.push({
      id: `up-${String(4_000_000 + i).slice(-7)}`,
      provider: 'unipayment',
      kind: 'deposit',
      createdAt: formatDate(daysAgo, hour, minute),
      email: pick(UNIPAYMENT_EMAILS, i),
      orderId: `UP-ORD-${String(500000 + i)}`,
      grossAmount,
      fee,
      netAmount,
      currency: 'USD',
      status,
    });
  }
  return rows;
}
