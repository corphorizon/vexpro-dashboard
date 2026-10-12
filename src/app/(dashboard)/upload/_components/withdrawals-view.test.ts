// El pie de Retiros de /upload, fijado: la migración «Libro mayor» lo sacó del
// JSX a una función pura y no puede moverlo ni un centavo.
import { describe, it, expect } from 'vitest';
import { withdrawalRowFlags, withdrawalsFormTotal, type WithdrawalAutoContext } from './withdrawals-view';

const ROWS = [
  { id: 'w1', category: 'ib_commissions', amount: 100 },
  { id: 'w2', category: 'broker', amount: 50 },
  { id: 'w3', category: 'prop_firm', amount: 20 },
  { id: 'w4', category: 'other', amount: 5 },
];

const manual: WithdrawalAutoContext = {
  brokerIsDerived: false,
  derivedBrokerAmount: 999, // ignorado: el período no es derivado
  ibEffective: { value: 100, source: 'manual' },
};

describe('withdrawalsFormTotal', () => {
  it('período no derivado: suma de los montos tecleados (el derivado NO entra)', () => {
    expect(withdrawalsFormTotal(ROWS, manual)).toBe(175);
  });

  it('período derivado: + broker derivado', () => {
    expect(withdrawalsFormTotal(ROWS, { ...manual, brokerIsDerived: true, derivedBrokerAmount: 1000 })).toBe(1175);
  });

  it('IB automático: entra el valor EFECTIVO, no el tecleado', () => {
    const ctx: WithdrawalAutoContext = {
      brokerIsDerived: true,
      derivedBrokerAmount: 820, // 1000 de API − 180 de IB (lo resta page.tsx)
      ibEffective: { value: 180, source: 'api' },
    };
    const rows = ROWS.map((r) => (r.category === 'ib_commissions' ? { ...r, amount: 0 } : r));
    // 180 (IB efectivo) + 50 + 20 + 5 + 820 = 1075
    expect(withdrawalsFormTotal(rows, ctx)).toBe(1075);
  });

  it('las dos puntas se cancelan: subir el IB efectivo y bajar el derivado deja el pie igual', () => {
    const base = { brokerIsDerived: true, derivedBrokerAmount: 1000, ibEffective: { value: 0, source: 'manual' } };
    const conIb = { brokerIsDerived: true, derivedBrokerAmount: 820, ibEffective: { value: 180, source: 'api' } };
    const rows = ROWS.map((r) => (r.category === 'ib_commissions' ? { ...r, amount: 0 } : r));
    expect(withdrawalsFormTotal(rows, conIb)).toBe(withdrawalsFormTotal(rows, base));
  });

  it('sin filas y sin derivado: 0 (no NaN)', () => {
    expect(withdrawalsFormTotal([], manual)).toBe(0);
  });
});

describe('withdrawalRowFlags', () => {
  it('broker es automático sólo en período derivado', () => {
    expect(withdrawalRowFlags(ROWS[1], manual).isBrokerAutoRow).toBe(false);
    expect(withdrawalRowFlags(ROWS[1], { ...manual, brokerIsDerived: true }).isBrokerAutoRow).toBe(true);
  });

  it('IB es automático sólo si la fuente es la API', () => {
    expect(withdrawalRowFlags(ROWS[0], manual).isIbAutoRow).toBe(false);
    expect(withdrawalRowFlags(ROWS[0], { ...manual, ibEffective: { value: 1, source: 'api' } }).isIbAutoRow).toBe(true);
  });

  it('las otras categorías nunca son automáticas', () => {
    const all: WithdrawalAutoContext = { brokerIsDerived: true, derivedBrokerAmount: 1, ibEffective: { value: 1, source: 'api' } };
    for (const r of [ROWS[2], ROWS[3]]) {
      expect(withdrawalRowFlags(r, all)).toEqual({ isBrokerAutoRow: false, isIbAutoRow: false });
    }
  });
});
