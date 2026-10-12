// /finanzas/consolidado: el aporte de la API que falla ya no es un 0
// silencioso (2026-10-12). Si la API no respondió, un mes derivado no tiene
// número: celda «—», total «—», CSV vacío. Los meses históricos no cambian.
import { describe, it, expect } from 'vitest';
import { moneyText } from '@/components/ui/money';
import {
  apiForMonth,
  columnTotal,
  csvAmount,
  monthsMissingApi,
  rowMoney,
  type ApiTotalsState,
  type RowMoneyInput,
} from './consolidado-model';

const summary = {
  totalDeposits: 1000,
  totalWithdrawals: 400,
  netDeposit: 600,
  withdrawals: [
    { category: 'broker', amount: 150 },
    { category: 'prop_firm', amount: 250 },
  ],
};

const OK: ApiTotalsState = { status: 'ok', months: { '2026-04': { deposits: 5000, withdrawals: 2000 } } };
const FAILED: ApiTotalsState = { status: 'failed' };
const LOADING: ApiTotalsState = { status: 'loading' };

function row(state: ApiTotalsState, monthKey: string, isDerived: boolean): RowMoneyInput {
  const api = apiForMonth(state, monthKey);
  return { summary, apiDeposits: api.deposits, apiWithdrawals: api.withdrawals, isDerived };
}

describe('apiForMonth', () => {
  it('OK: el mes de la respuesta', () => {
    expect(apiForMonth(OK, '2026-04')).toEqual({ deposits: 5000, withdrawals: 2000 });
  });

  it('OK sin entrada para el mes: 0 (la RPC sólo lista meses con movimiento)', () => {
    expect(apiForMonth(OK, '2026-05')).toEqual({ deposits: 0, withdrawals: 0 });
  });

  it('falló o todavía carga: null, NUNCA 0', () => {
    expect(apiForMonth(FAILED, '2026-04')).toEqual({ deposits: null, withdrawals: null });
    expect(apiForMonth(LOADING, '2026-04')).toEqual({ deposits: null, withdrawals: null });
  });
});

describe('rowMoney', () => {
  it('mes derivado con API: API + manual por la fórmula única (sin cambios)', () => {
    expect(rowMoney(row(OK, '2026-04', true))).toEqual({
      totalDeposits: 6000, // 5000 API + 1000 manual
      totalWithdrawals: 2150, // 2000 API + 150 broker manual
      netDeposit: 3850,
    });
  });

  it('mes derivado y la API FALLÓ: las tres cifras son null y se muestran «—»', () => {
    const m = rowMoney(row(FAILED, '2026-04', true));
    expect(m).toEqual({ totalDeposits: null, totalWithdrawals: null, netDeposit: null });
    // Lo que pinta la celda (Money / moneyText): «—», no «$1,000.00» (sólo el manual).
    expect(moneyText(m.totalDeposits)).toBe('—');
    expect(moneyText(m.netDeposit)).toBe('—');
  });

  it('mes derivado mientras la API carga: tampoco se muestra el manual solo', () => {
    expect(rowMoney(row(LOADING, '2026-04', true)).netDeposit).toBeNull();
  });

  it('mes histórico: manda lo manual aunque la API falle (no depende de ella)', () => {
    expect(rowMoney(row(FAILED, '2026-03', false))).toEqual({
      totalDeposits: 1000,
      totalWithdrawals: 400,
      netDeposit: 600,
    });
  });
});

describe('columnTotal', () => {
  it('suma como antes cuando todo tiene valor', () => {
    expect(columnTotal([600, 3850], 'sum')).toBe(4450);
  });

  it('un mes sin dato → el total es null («—»), no la suma de los demás', () => {
    const total = columnTotal([600, null], 'sum');
    expect(total).toBeNull();
    expect(moneyText(total)).toBe('—');
  });

  it("'last' toma el último mes; 'none' no tiene total", () => {
    expect(columnTotal([10, 20, 30], 'last')).toBe(30);
    expect(columnTotal([10, null], 'last')).toBeNull();
    expect(columnTotal([10, 20], 'none')).toBeUndefined();
  });

  it('sin meses: 0 (como antes)', () => {
    expect(columnTotal([], 'sum')).toBe(0);
    expect(columnTotal([], 'last')).toBe(0);
  });
});

describe('csvAmount', () => {
  it('mismo formato de siempre; vacío si no lo sabemos', () => {
    expect(csvAmount(1234.5)).toBe('1234.50');
    expect(csvAmount(0)).toBe('0.00');
    expect(csvAmount(null)).toBe('');
    expect(csvAmount(undefined)).toBe('');
  });
});

describe('monthsMissingApi', () => {
  it('cuenta sólo los meses derivados sin dato de la API (para el aviso)', () => {
    expect(
      monthsMissingApi([row(FAILED, '2026-03', false), row(FAILED, '2026-04', true), row(FAILED, '2026-05', true)]),
    ).toBe(2);
    expect(monthsMissingApi([row(OK, '2026-04', true)])).toBe(0);
  });
});
