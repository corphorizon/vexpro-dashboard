import { describe, it, expect } from 'vitest';
import {
  LOCATION_TYPES,
  normalizeLocationType,
  isLiquid,
  isAutomatic,
  summarize,
  groupByUnit,
  groupByType,
  type BusinessUnit,
  type CashLocation,
} from './cash-locations';

function unit(partial: Partial<BusinessUnit> & { id: string }): BusinessUnit {
  return {
    company_id: 'c1', name: partial.id, counts_to_fund: true,
    is_active: true, sort_order: 0, ...partial,
  };
}

let seq = 0;
function loc(partial: Partial<CashLocation>): CashLocation {
  seq += 1;
  return {
    channel_key: `k${seq}`, label: `Ubicación ${seq}`,
    location_type: 'wallet', business_unit_id: null, holder: null,
    is_visible: true, sort_order: seq, balance: 0,
    ...partial,
  };
}

describe('tipos de ubicación', () => {
  it('un valor desconocido cae en wallet, no rompe', () => {
    expect(normalizeLocationType('inventado')).toBe('wallet');
    expect(normalizeLocationType(null)).toBe('wallet');
  });

  // La regla que da sentido a todo el módulo: lo prestado es patrimonio pero
  // no es caja disponible.
  it('solo lo prestado deja de ser líquido', () => {
    for (const t of LOCATION_TYPES) {
      expect(isLiquid(t), t).toBe(t !== 'loan');
    }
  });

  it('solo las pasarelas se sincronizan solas', () => {
    expect(isAutomatic('gateway')).toBe(true);
    expect(isAutomatic('bank')).toBe(false);
    expect(isAutomatic('wallet')).toBe(false);
  });
});

describe('summarize', () => {
  // Números reales de Horizon: $48.351 prestados que no volvieron.
  it('separa lo disponible de lo prestado sin perder el total', () => {
    const s = summarize([
      loc({ location_type: 'wallet', balance: 20_000 }),
      loc({ location_type: 'bank', balance: 5_000 }),
      loc({ location_type: 'loan', balance: 48_351, holder: 'Kevin' }),
    ], []);
    expect(s.liquid).toBe(25_000);
    expect(s.lent).toBe(48_351);
    expect(s.total).toBe(73_351);
  });

  it('el fondo excluye a las unidades que se llevan aparte', () => {
    const horizon = unit({ id: 'u1', name: 'Horizon', counts_to_fund: true });
    const exura = unit({ id: 'u2', name: 'Exura', counts_to_fund: false, sort_order: 1 });
    const s = summarize([
      loc({ business_unit_id: 'u1', balance: 10_000 }),
      loc({ business_unit_id: 'u2', balance: 7_000 }),
    ], [horizon, exura]);
    expect(s.fund).toBe(10_000);
    expect(s.outsideFund).toBe(7_000);
  });

  // Una ubicación sin unidad asignada no puede desaparecer del ahorro real:
  // esa plata existe igual.
  it('lo que no tiene unidad asignada entra al fondo', () => {
    const s = summarize([loc({ business_unit_id: null, balance: 3_000 })], [
      unit({ id: 'u1', counts_to_fund: false }),
    ]);
    expect(s.fund).toBe(3_000);
    expect(s.outsideFund).toBe(0);
  });

  it('un saldo negativo resta, no se ignora', () => {
    const s = summarize([
      loc({ balance: 1_000 }),
      loc({ balance: -300 }),
    ], []);
    expect(s.liquid).toBe(700);
  });

  it('sin ubicaciones da todo en cero', () => {
    expect(summarize([], [])).toEqual({ liquid: 0, lent: 0, total: 0, fund: 0, outsideFund: 0 });
  });
});

describe('agrupaciones', () => {
  it('agrupa por unidad y deja lo no asignado al final', () => {
    const g = groupByUnit([
      loc({ business_unit_id: null, balance: 100 }),
      loc({ business_unit_id: 'u2', balance: 200 }),
      loc({ business_unit_id: 'u1', balance: 300 }),
      loc({ business_unit_id: 'u1', balance: 50 }),
    ], [unit({ id: 'u1', name: 'Horizon', sort_order: 0 }), unit({ id: 'u2', name: 'Exura', sort_order: 1 })]);

    expect(g[0].unit?.name).toBe('Horizon');
    expect(g[0].total).toBe(350);
    expect(g[1].unit?.name).toBe('Exura');
    expect(g[g.length - 1].unit).toBeNull();
  });

  it('agrupa por tipo en el orden del catálogo', () => {
    const g = groupByType([
      loc({ location_type: 'loan', balance: 500 }),
      loc({ location_type: 'gateway', balance: 1_000 }),
      loc({ location_type: 'gateway', balance: 250 }),
    ]);
    expect(g.map((x) => x.type)).toEqual(['gateway', 'loan']);
    expect(g[0]).toEqual({ type: 'gateway', total: 1_250, count: 2 });
  });
});
