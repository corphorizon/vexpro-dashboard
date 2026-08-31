import { describe, it, expect } from 'vitest';
import {
  computeProviderTotals,
  acceptedTransactions,
  countPayprosPayouts,
  filterByDateRange,
  monthRange,
  ACCEPTED_STATUS,
} from './totals';
import type {
  CoinsbuyDepositTx,
  CoinsbuyWithdrawalTx,
  FairpayDepositTx,
  UnipaymentDepositTx,
  PayprosDepositTx,
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

  it('no cuenta las transferencias internas (internal: true, txid null en Coinsbuy)', () => {
    // Transferencia entre wallets propias (ej. Savings→Main): status Approved
    // pero internal — no debe sumar en Retiros Totales ni Net Deposit.
    const t = computeProviderTotals(ds('coinsbuy-withdrawals', [
      cbWd({ chargedAmount: 2000, commission: 20, status: 'Approved' }),
      cbWd({ chargedAmount: 30000, commission: 0, status: 'Approved', internal: true }),
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

  it('fairpay con comisión configurada (fee_pct): total = suma de netos (billed − mdr) y feeTotal = suma de mdr', () => {
    // Simula el output del fetcher con extra_config.fee_pct = 8:
    // mdr = round2(billed × 0.08), net = round2(billed − mdr).
    const t = computeProviderTotals(ds('fairpay', [
      fp({ billed: 100, mdr: 8, net: 92, status: 'Completed' }),
      fp({ billed: 250.5, mdr: 20.04, net: 230.46, status: 'Completed' }),
      fp({ billed: 50, mdr: 4, net: 46, status: 'Pending' }), // no cuenta
    ]));
    expect(t.total).toBeCloseTo(322.46, 2);   // 92 + 230.46
    expect(t.feeTotal).toBeCloseTo(28.04, 2); // 8 + 20.04
    expect(t.count).toBe(2);
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

describe('computeProviderTotals — Pay-Pros', () => {
  // Datos reales de Vex Pro al 2026-08-31: 61 filas, todas status 'paid',
  // todas USD, todas del espejo del CRM (external_id 'crm:<depositId>').
  const pp = (o: Partial<PayprosDepositTx>): PayprosDepositTx =>
    ({
      id: 'crm:1', provider: 'paypros', kind: 'deposit',
      createdAt: '2026-08-15T10:00:00Z', amount: 0, currency: 'USD',
      status: 'paid', notifyReference: '',
      ...o,
    }) as PayprosDepositTx;

  it("suma solo 'paid' — el depósito cobrado (código 4 del webhook)", () => {
    const t = computeProviderTotals(ds('paypros', [
      pp({ id: 'a', amount: 500 }),
      pp({ id: 'b', amount: 15 }),
      pp({ id: 'c', amount: 999, status: 'unpaid' }),
      pp({ id: 'd', amount: 111, status: 'refund_approved' }),
    ]));
    expect(t.total).toBe(515);
    expect(t.count).toBe(2);
    expect(t.acceptedStatus).toBe('paid');
  });

  it('un payout NO se resta de los depósitos (escondería un retiro adentro)', () => {
    const rows = [
      pp({ id: 'a', amount: 500 }),
      pp({ id: 'p', amount: 300, status: 'payout_paid', kind: 'withdrawal' }),
    ];
    expect(computeProviderTotals(ds('paypros', rows)).total).toBe(500);
    // …pero su existencia NO es silenciosa: se puede contar y avisar.
    expect(countPayprosPayouts(ds('paypros', rows))).toEqual({ count: 1, total: 300 });
  });

  it('sin payouts, countPayprosPayouts devuelve cero (no null)', () => {
    expect(countPayprosPayouts(ds('paypros', [pp({ amount: 10 })]))).toEqual({
      count: 0,
      total: 0,
    });
  });

  it('la comisión es 0: Pay-Pros no informa fee', () => {
    expect(computeProviderTotals(ds('paypros', [pp({ amount: 10 })])).feeTotal).toBe(0);
  });

  it('el status aceptado coincide con el del RPC del libro (migración 082)', () => {
    expect(ACCEPTED_STATUS.paypros).toBe('paid');
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
