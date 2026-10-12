import { describe, expect, it } from 'vitest';
import { computeDerivedNetDeposit } from '@/lib/broker-logic';
import {
  buildDepositRows,
  buildWithdrawalRows,
  channelCoverage,
  sharePct,
  sumOfRows,
  withdrawalCategorySums,
} from './channel-rows';

const SLUG: Record<string, string | null> = {
  coinsbuy: 'coinsbuy-deposits',
  fairpay: 'fairpay',
  unipayment: 'unipayment',
  paypros: 'paypros',
  other: null,
};
const CHANNELS = ['coinsbuy', 'fairpay', 'unipayment', 'paypros', 'other'];

const depositInput = (api: Record<string, number | null>, manual: Record<string, number>, derived = true) => ({
  channels: CHANNELS,
  derived,
  apiSlugOf: (ch: string) => SLUG[ch],
  apiAmountOf: (slug: string) => (slug in api ? api[slug] : null),
  manualOf: (ch: string) => manual[ch] ?? 0,
  labelOf: (ch: string) => ch,
});

describe('buildDepositRows — canal sin dato', () => {
  it('un canal de API cuyo dataset no llegó es null («sin dato»), nunca $0', () => {
    const rows = buildDepositRows(
      depositInput({ 'coinsbuy-deposits': 1000, fairpay: null, unipayment: 0, paypros: 300 }, { other: 50 }),
    );
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.fairpay.amount).toBeNull();
    expect(by.unipayment.amount).toBe(0); // dato que dice cero: es cero
    expect(by.other).toMatchObject({ amount: 50, source: 'manual', isApi: false });
  });

  it('API + manual coexisten en la misma fila y el rótulo lo dice', () => {
    const [cb] = buildDepositRows(depositInput({ 'coinsbuy-deposits': 1000 }, { coinsbuy: 25 }));
    expect(cb).toMatchObject({ amount: 1025, apiAmount: 1000, manualAmount: 25, source: 'api+manual' });
  });

  it('período histórico: todo es manual, ningún canal está «sin dato»', () => {
    const rows = buildDepositRows(depositInput({}, { coinsbuy: 10, fairpay: 5 }, false));
    expect(rows.every((r) => r.source === 'manual' && r.amount !== null && !r.isApi)).toBe(true);
    expect(channelCoverage(rows)).toMatchObject({ withData: 5, total: 5 });
  });

  it('Σ filas con dato === total de depósitos de computeDerivedNetDeposit cuando no falta nada', () => {
    const api = { 'coinsbuy-deposits': 1000.1, fairpay: 200.2, unipayment: 30.3, paypros: 4.4 };
    const manual = { coinsbuy: 1, other: 50 };
    const rows = buildDepositRows(depositInput(api, manual));
    const derived = computeDerivedNetDeposit({
      apiDeposits: Object.values(api).reduce((s, v) => s + v, 0),
      manualDepositsTotal: 51,
      apiWithdrawals: 0,
      manualBroker: 0,
    });
    expect(sumOfRows(rows)).toBe(Math.round(derived.totalDeposits * 100) / 100);
  });
});

describe('«N de M canales»', () => {
  it('cuenta sólo las filas que suman, y nombra las que faltan', () => {
    const rows = buildDepositRows(depositInput({ 'coinsbuy-deposits': 1, fairpay: null, unipayment: 2, paypros: null }, {}));
    const cov = channelCoverage(rows);
    expect(cov).toMatchObject({ withData: 3, total: 5 });
    expect(cov.missing.map((r) => r.key)).toEqual(['fairpay', 'paypros']);
  });

  it('retiros: «1 de 3 canales» con un canal de API sin dato (Broker manual cuenta como canal)', () => {
    const rows = buildWithdrawalRows({
      derived: true,
      apiChannels: [
        { key: 'coinsbuy', label: 'Coinsbuy', amount: 500 },
        { key: 'paypros', label: 'Pay-Pros', amount: null },
      ],
      categories: [{ key: 'broker', label: 'Broker', amount: 0, source: 'manual' }],
      p2p: { label: 'P2P', amount: 9, source: 'api' },
    });
    expect(channelCoverage(rows)).toMatchObject({ withData: 2, total: 3 });
  });
});

describe('buildWithdrawalRows — qué suma y qué es informativo', () => {
  const categories = [
    { key: 'ib_commissions', label: 'IB', amount: 180_000, source: 'api' as const },
    { key: 'broker', label: 'Broker', amount: 1_000, source: 'manual' as const },
    { key: 'prop_firm', label: 'PF', amount: 11_981.7, source: 'api' as const },
    { key: 'other', label: 'Otros', amount: 40, source: 'manual' as const },
  ];

  it('derivado: suman la API y el Broker manual; IB / Prop Firm / Otros / P2P son informativas', () => {
    const rows = buildWithdrawalRows({
      derived: true,
      apiChannels: [
        { key: 'coinsbuy', label: 'Coinsbuy', amount: 469_650.98 },
        { key: 'paypros', label: 'Pay-Pros', amount: 2_617.62 },
      ],
      categories,
      p2p: { label: 'P2P', amount: 29_403.67, source: 'api' },
    });
    expect(rows.filter((r) => r.sums).map((r) => r.key)).toEqual(['api:coinsbuy', 'api:paypros', 'cat:broker']);
    expect(rows.filter((r) => !r.sums).map((r) => r.key)).toEqual(['cat:ib_commissions', 'cat:prop_firm', 'cat:other', 'p2p']);
    // Cruce con la fórmula canónica: la tabla no puede decir otro número.
    const canon = computeDerivedNetDeposit({
      apiDeposits: 0,
      manualDepositsTotal: 0,
      apiWithdrawals: 469_650.98 + 2_617.62,
      manualBroker: 1_000,
    });
    expect(sumOfRows(rows)).toBe(Math.round(canon.totalWithdrawals * 100) / 100);
  });

  it('histórico: suman todas las categorías menos Prop Firm (data-context), sin filas de API', () => {
    const rows = buildWithdrawalRows({
      derived: false,
      apiChannels: [{ key: 'coinsbuy', label: 'Coinsbuy', amount: 999 }],
      categories,
      p2p: { label: 'P2P', amount: 1, source: 'manual' },
    });
    expect(rows.some((r) => r.isApi)).toBe(false);
    expect(sumOfRows(rows)).toBe(180_000 + 1_000 + 40);
    expect(withdrawalCategorySums('prop_firm', false)).toBe(false);
    expect(withdrawalCategorySums('ib_commissions', true)).toBe(false);
  });
});

describe('sharePct', () => {
  it('null cuando la fila no tiene dato, no suma, o el total no es positivo', () => {
    expect(sharePct({ amount: 25, sums: true }, 100)).toBe(25);
    expect(sharePct({ amount: null, sums: true }, 100)).toBeNull();
    expect(sharePct({ amount: 25, sums: false }, 100)).toBeNull();
    expect(sharePct({ amount: 25, sums: true }, 0)).toBeNull();
    expect(sharePct({ amount: 25, sums: true }, -10)).toBeNull();
  });
});
