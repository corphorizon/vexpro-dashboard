import { describe, expect, it } from 'vitest';
import { closingOverrides, propFirmAutoForMonth } from './close-auto-inputs';
import { resolveBrokerPnl } from './broker-pnl';
import { applySnapshotOverrides } from './distribution-snapshot';

// Incidente 2026-10-12: el cierre de Ago-26 de Vex congeló el manual $671.000
// y Prop Firm 0, en vez de lo que la pantalla del mes abierto mostraba.
const dias = (y: number, m: number, n: number, pnlCliente: number) =>
  Array.from({ length: n }, (_, i) => ({
    utc_day: `${y}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
    pnl_usd: pnlCliente / n,
  }));

describe('closingOverrides', () => {
  it('congela el Broker P&L del CRM (signo del bróker) y la Prop Firm automática', () => {
    const o = closingOverrides({
      year: 2026,
      month: 8,
      dailyPnl: dias(2026, 8, 31, -304392.24),
      crmMonthly: [
        { year: 2026, month: 8, metric: 'propfirm_sales', auto: 12196.7 },
        { year: 2026, month: 8, metric: 'propfirm_withdrawals', auto: 2989.73 },
      ],
    });
    expect(o.broker_pnl).toBeCloseTo(304392.24, 2);
    expect(o.prop_firm_sales).toBe(12196.7);
    expect(o.prop_firm_withdrawals).toBe(2989.73);
    expect(o.auto_sources).toEqual(['broker_pnl', 'prop_firm_sales', 'prop_firm_withdrawals']);
  });

  it('sin serie del CRM no manda override: la RPC congela el manual (nunca 0)', () => {
    const o = closingOverrides({ year: 2026, month: 9, dailyPnl: [], crmMonthly: [] });
    expect(o).toEqual({ auto_sources: [] });
  });

  it('antes del corte de ago-26 no toca el Broker P&L', () => {
    const o = closingOverrides({ year: 2026, month: 7, dailyPnl: dias(2026, 7, 31, -1000), crmMonthly: [] });
    expect(o.broker_pnl).toBeUndefined();
  });

  it('Prop Firm: una sola métrica presente → la otra vale 0; ninguna → null', () => {
    expect(propFirmAutoForMonth([{ year: 2026, month: 9, metric: 'propfirm_sales', auto: 5 }], 2026, 9)).toEqual({ sales: 5, withdrawals: 0 });
    expect(propFirmAutoForMonth([], 2026, 9)).toBeNull();
  });
});

describe('período cerrado con valores del CRM', () => {
  it('resolveBrokerPnl lee lo congelado, no la tabla manual', () => {
    const r = resolveBrokerPnl(
      { year: 2026, month: 8, is_closed: true, closing_snapshot: { broker_pnl: 304392.24 } },
      new Map(),
      671000,
    );
    expect(r).toMatchObject({ value: 304392.24, source: 'frozen' });
  });

  it('sin snapshot sigue leyendo el manual', () => {
    expect(resolveBrokerPnl({ year: 2026, month: 6, is_closed: true }, new Map(), 96762).value).toBe(96762);
  });

  it('no reporta deriva falsa en los campos que salieron del CRM', () => {
    const live = [{ periodId: 'ago', brokerPnl: 671000, other: 0, propFirmNetIncome: 0, investmentProfits: 0, totalExpenses: 10, reservePct: 0.1 }];
    const { drifts, inputs } = applySnapshotOverrides(
      [{
        id: 'ago', label: 'Ago 26', is_closed: true,
        closing_snapshot: {
          broker_pnl: 304392.24, prop_firm_sales: 12196.7, prop_firm_withdrawals: 2989.73,
          other_income: 0, investment_profits: 0, total_expenses: 20, reserve_pct: 0.1,
          auto_sources: ['broker_pnl', 'prop_firm_sales', 'prop_firm_withdrawals'],
        },
      }],
      live,
    );
    expect(inputs[0].brokerPnl).toBe(304392.24);
    expect(drifts.map((d) => d.field)).toEqual(['totalExpenses']);
  });
});
