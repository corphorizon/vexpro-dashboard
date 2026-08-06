import { describe, it, expect } from 'vitest';
import {
  applySnapshotOverrides,
  snapshotToInput,
  type PeriodLike,
} from './distribution-snapshot';
import { computeDistributionChain, type PeriodDistInput } from './distribution';

const input = (periodId: string, over: Partial<PeriodDistInput> = {}): PeriodDistInput => ({
  periodId,
  brokerPnl: 100_000,
  other: 0,
  propFirmNetIncome: 5_000,
  investmentProfits: 2_000,
  totalExpenses: 60_000,
  reservePct: 0.1,
  ...over,
});

const SNAP = {
  broker_pnl: 100_000,
  other_income: 0,
  prop_firm_sales: 8_000,
  prop_firm_withdrawals: 3_000,
  investment_profits: 2_000,
  total_expenses: 60_000,
  reserve_pct: 0.1,
};

describe('snapshotToInput', () => {
  it('mapea el jsonb de close_period, con prop firm en neto', () => {
    const r = snapshotToInput('p1', SNAP);
    expect(r.propFirmNetIncome).toBe(5_000); // 8000 − 3000
    expect(r.brokerPnl).toBe(100_000);
    expect(r.reservePct).toBe(0.1);
  });

  it('numeric de Postgres llega como string y se convierte', () => {
    const r = snapshotToInput('p1', { ...SNAP, broker_pnl: '78962.00', total_expenses: '82795.40' });
    expect(r.brokerPnl).toBe(78_962);
    expect(r.totalExpenses).toBe(82_795.4);
  });
});

describe('applySnapshotOverrides', () => {
  const periods: PeriodLike[] = [
    { id: 'mar', label: 'Mar 26', is_closed: true, closing_snapshot: SNAP },
    { id: 'abr', label: 'Abr 26', is_closed: false, closing_snapshot: null },
  ];

  it('el mes cerrado usa lo congelado; el abierto sigue vivo', () => {
    // Alguien editó una inversión de marzo DESPUÉS del cierre: vivo dice 9000.
    const live = [input('mar', { investmentProfits: 9_000 }), input('abr')];
    const { inputs, drifts } = applySnapshotOverrides(periods, live);

    expect(inputs[0].investmentProfits).toBe(2_000); // manda el congelador
    expect(inputs[1].investmentProfits).toBe(2_000); // abril vivo, sin tocar

    // Y la edición retroactiva ya no pasa desapercibida.
    expect(drifts).toEqual([
      { periodId: 'mar', periodLabel: 'Mar 26', field: 'investmentProfits', frozen: 2_000, live: 9_000 },
    ]);
  });

  it('sin ediciones retroactivas no hay deriva', () => {
    const { drifts } = applySnapshotOverrides(periods, [input('mar'), input('abr')]);
    expect(drifts).toEqual([]);
  });

  it('cerrado SIN snapshot (tenant nuevo) conserva los insumos vivos', () => {
    const p: PeriodLike[] = [{ id: 'x', label: 'X', is_closed: true, closing_snapshot: null }];
    const { inputs, drifts } = applySnapshotOverrides(p, [input('x', { brokerPnl: 123 })]);
    expect(inputs[0].brokerPnl).toBe(123);
    expect(drifts).toEqual([]);
  });

  it('preserva los campos extra del input (contrato con el forecast)', () => {
    const enriched = [{ ...input('mar'), year: 2026, month: 3, label: 'Mar 26', isClosed: true }];
    const { inputs } = applySnapshotOverrides(periods, enriched);
    expect(inputs[0].year).toBe(2026);
    expect(inputs[0].label).toBe('Mar 26');
  });

  // El invariante de fondo: con el override, el resultado del mes cerrado es
  // ESTABLE ante ediciones retroactivas — y la cadena posterior también.
  it('la cadena del mes cerrado no cambia aunque las tablas vivas cambien', () => {
    const antes = applySnapshotOverrides(periods, [input('mar'), input('abr')]);
    const despues = applySnapshotOverrides(periods, [
      input('mar', { totalExpenses: 999_999 }), // sabotaje retroactivo
      input('abr'),
    ]);
    const chainAntes = computeDistributionChain(antes.inputs);
    const chainDespues = computeDistributionChain(despues.inputs);
    expect(chainDespues.get('mar')!.montoDistribuir).toBe(chainAntes.get('mar')!.montoDistribuir);
    expect(chainDespues.get('abr')!.montoDistribuir).toBe(chainAntes.get('abr')!.montoDistribuir);
    expect(despues.drifts.some((d) => d.field === 'totalExpenses')).toBe(true);
  });
});
