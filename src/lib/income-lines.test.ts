import { describe, it, expect } from 'vitest';
import {
  computeIncomeTotals,
  computeIncomePending,
  validateIncomeLine,
  groupByClient,
  type IncomeLine,
} from './income-lines';

let seq = 0;
function line(partial: Partial<IncomeLine>): IncomeLine {
  seq += 1;
  return {
    id: `l${seq}`, company_id: 'c1', period_id: 'p1',
    concept: 'Servicio', client: null,
    amount: 100, received: 100, pending: 0,
    category: null, reference: null, income_date: null, sort_order: seq,
    created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
    ...partial,
  };
}

describe('computeIncomeTotals', () => {
  // Números reales de Ene 26 de la contabilidad de Horizon: facturó 23.000,
  // cobró 13.500 y quedaron 9.500 por cobrar.
  it('separa facturado de cobrado', () => {
    const t = computeIncomeTotals([
      line({ amount: 10_000, received: 10_000, pending: 0 }),
      line({ amount: 6_000, received: 0, pending: 6_000 }),
      line({ amount: 2_500, received: 2_500, pending: 0 }),
      line({ amount: 2_500, received: 0, pending: 2_500 }),
      line({ amount: 2_000, received: 1_000, pending: 1_000 }),
    ]);
    expect(t.amount).toBe(23_000);
    expect(t.received).toBe(13_500);
    expect(t.pending).toBe(9_500);
  });

  it('no arrastra error de coma flotante', () => {
    const t = computeIncomeTotals([
      line({ amount: 0.1, received: 0.1, pending: 0 }),
      line({ amount: 0.2, received: 0.2, pending: 0 }),
    ]);
    expect(t.amount).toBe(0.3);
  });

  it('una lista vacía da todo en cero', () => {
    expect(computeIncomeTotals([])).toEqual({ amount: 0, received: 0, pending: 0 });
  });
});

describe('computeIncomePending', () => {
  it('deriva pendiente = facturado − cobrado', () => {
    expect(computeIncomePending(2000, 1000)).toBe(1000);
    expect(computeIncomePending('2500', '0', '')).toBe(2500);
  });

  it('respeta un pendiente explícito mayor que cero', () => {
    expect(computeIncomePending(2000, 1000, 800)).toBe(800);
  });

  it('cobrado igual al facturado deja pendiente en cero', () => {
    expect(computeIncomePending(1090, 1090)).toBe(0);
  });
});

describe('validateIncomeLine', () => {
  const ok = { concept: 'Vex Pro CRM', amount: 10_000, received: 10_000 };

  it('acepta una línea bien formada', () => {
    expect(validateIncomeLine(ok)).toBeNull();
  });

  it('acepta facturado sin cobrar', () => {
    expect(validateIncomeLine({ ...ok, received: 0 })).toBeNull();
  });

  it('rechaza concepto vacío y monto no numérico', () => {
    expect(validateIncomeLine({ ...ok, concept: '  ' })).toMatch(/concepto/i);
    expect(validateIncomeLine({ ...ok, amount: NaN })).toMatch(/monto/i);
  });

  // Lo cobrado es lo que la cadena reparte: cobrar de más descuadra la
  // distribución sin que nada más lo delate.
  it('rechaza cobrar más de lo facturado', () => {
    expect(validateIncomeLine({ ...ok, received: 10_001 })).toMatch(/superar/i);
  });

  it('tolera un centavo de diferencia por redondeo', () => {
    expect(validateIncomeLine({ ...ok, received: 10_000.01 })).toBeNull();
  });
});

describe('groupByClient', () => {
  it('agrupa y ordena por facturación descendente', () => {
    const g = groupByClient([
      line({ client: 'Be Prime', amount: 6_000, received: 6_000 }),
      line({ client: 'Vex Pro', amount: 10_000, received: 10_000 }),
      line({ client: 'Vex Pro', amount: 2_500, received: 0, pending: 2_500 }),
    ]);
    expect(g[0].client).toBe('Vex Pro');
    expect(g[0].totals.amount).toBe(12_500);
    expect(g[0].totals.pending).toBe(2_500);
    expect(g[1].client).toBe('Be Prime');
  });

  it('junta las líneas sin cliente bajo una sola etiqueta', () => {
    const g = groupByClient([line({ client: null }), line({ client: '   ' })]);
    expect(g).toHaveLength(1);
    expect(g[0].client).toBe('Sin asignar');
  });
});
