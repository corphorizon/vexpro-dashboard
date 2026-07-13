import { describe, it, expect } from 'vitest';
import {
  computeProviderTotals,
  acceptedTransactions,
  filterByDateRange,
  monthRange,
} from './totals';
import type {
  CoinsbuyDepositTx,
  CoinsbuyWithdrawalTx,
  FairpayDepositTx,
  UnipaymentDepositTx,
  ProviderDataset,
} from './types';

// QA-01: agrega dinero real de 3 proveedores y decide qué cuenta como
// "aceptado". Un error acá corrompe todos los totales de /movimientos.

const cbDep = (o: Partial<CoinsbuyDepositTx>): CoinsbuyDepositTx => ({
  id: 'x', provider: 'coinsbuy', kind: 'deposit', createdAt: '2026-05-15T10:00:00Z',
  label: '', trackingId: '', commission: 0, amountTarget: 0, currency: 'USD',
  status: 'Confirmed', ...o,
} as CoinsbuyDepositTx);

const cbWd = (o: Partial<CoinsbuyWithdrawalTx>): CoinsbuyWithdrawalTx => ({
  id: 'x', provider: 'coinsbuy', kind: 'withdrawal', createdAt: '2026-05-15T10:00:00Z',
  label: '', trackingId: '', amount: 0, chargedAmount: 0, commission: 0, currency: 'USD',
  status: 'Approved', ...o,
} as CoinsbuyWithdrawalTx);

const fp = (o: Partial<FairpayDepositTx>): FairpayDepositTx => ({
  id: 'x', provider: 'fairpay', kind: 'deposit', createdAt: '2026-05-15T10:00:00Z',
  customerEmail: '', billed: 0, mdr: 0, net: 0, currency: 'USD', status: 'Completed', ...o,
} as FairpayDepositTx);

const up = (o: Partial<UnipaymentDepositTx>): UnipaymentDepositTx => ({
  id: 'x', provider: 'unipayment', kind: 'deposit', createdAt: '2026-05-15T10:00:00Z',
  email: '', orderId: '', grossAmount: 0, fee: 0, netAmount: 0, currency: 'USD',
  status: 'Completed', ...o,
} as UnipaymentDepositTx);

const ds = <T,>(slug: string, transactions: T[]): ProviderDataset =>
  ({ slug, transactions, kind: 'deposits', fetchedAt: '', status: 'ok', isMock: false } as unknown as ProviderDataset);

describe('computeProviderTotals — coinsbuy deposits', () => {
  it('suma amountTarget solo de las Confirmed y no-excluidas', () => {
    const t = computeProviderTotals(ds('coinsbuy-deposits', [
      cbDep({ amountTarget: 1000, commission: 10, status: 'Confirmed' }),
      cbDep({ amountTarget: 500, commission: 5, status: 'Pending' }),   // no cuenta
      cbDep({ amountTarget: 999, commission: 9, status: 'Failed' }),    // no cuenta
      cbDep({ amountTarget: 300, commission: 3, status: 'Confirmed', excluded: true } as Partial<CoinsbuyDepositTx>), // excluida manual
    ]));
    expect(t.total).toBe(1000);
    expect(t.count).toBe(1);
    expect(t.feeTotal).toBe(10);
    expect(t.acceptedStatus).toBe('Confirmed');
  });
});

describe('computeProviderTotals — coinsbuy withdrawals', () => {
  it('suma chargedAmount solo de las Approved y no-excluidas', () => {
    const t = computeProviderTotals(ds('coinsbuy-withdrawals', [
      cbWd({ chargedAmount: 2000, commission: 20, status: 'Approved' }),
      cbWd({ chargedAmount: 700, commission: 7, status: 'Approved', excluded: true } as Partial<CoinsbuyWithdrawalTx>),
    ]));
    expect(t.total).toBe(2000);
    expect(t.count).toBe(1);
    expect(t.feeTotal).toBe(20);
  });
});

describe('computeProviderTotals — fairpay / unipayment', () => {
  it('fairpay suma net y fee=mdr solo de Completed', () => {
    const t = computeProviderTotals(ds('fairpay', [
      fp({ net: 100, mdr: 3, status: 'Completed' }),
      fp({ net: 50, mdr: 1, status: 'Pending' }),
    ]));
    expect(t.total).toBe(100);
    expect(t.feeTotal).toBe(3);
    expect(t.count).toBe(1);
  });

  it('unipayment suma netAmount y fee solo de Completed', () => {
    const t = computeProviderTotals(ds('unipayment', [
      up({ netAmount: 200, fee: 4, status: 'Completed' }),
      up({ netAmount: 80, fee: 2, status: 'Expired' }),
    ]));
    expect(t.total).toBe(200);
    expect(t.feeTotal).toBe(4);
    expect(t.count).toBe(1);
  });
});

describe('acceptedTransactions', () => {
  it('filtra por el status aceptado del slug', () => {
    const rows = acceptedTransactions(ds('fairpay', [
      fp({ status: 'Completed' }), fp({ status: 'Pending' }), fp({ status: 'Completed' }),
    ]));
    expect(rows).toHaveLength(2);
  });
});

describe('filterByDateRange', () => {
  const rows = [
    fp({ createdAt: '2026-05-01T12:00:00' }),
    fp({ createdAt: '2026-05-15T12:00:00' }),
    fp({ createdAt: '2026-05-31T23:00:00' }),
    fp({ createdAt: '2026-06-01T00:30:00' }),
  ];
  it('rango inclusivo [from, to]', () => {
    expect(filterByDateRange(rows, '2026-05-01', '2026-05-31')).toHaveLength(3);
  });
  it('sin from/to devuelve todo', () => {
    expect(filterByDateRange(rows)).toHaveLength(4);
  });
  it('open-ended (solo from)', () => {
    expect(filterByDateRange(rows, '2026-05-15')).toHaveLength(3);
  });
});

describe('monthRange', () => {
  it('primer y último día del mes dado', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2026-05')).toEqual({ from: '2026-05-01', to: '2026-05-31' });
  });
  it('maneja años bisiestos (feb 2024 → 29)', () => {
    expect(monthRange('2024-02').to).toBe('2024-02-29');
  });
});
