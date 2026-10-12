import { describe, expect, it } from 'vitest';
import { connectionEquityTag, differsFromMt5, poolStatusKind, poolTotals, toAmount } from './pool-view-model';

describe('toAmount', () => {
  it('número o texto numérico', () => {
    expect(toAmount(12.5)).toBe(12.5);
    expect(toAmount('1234.56')).toBe(1234.56);
    expect(toAmount(0)).toBe(0);
    expect(toAmount(-3)).toBe(-3);
  });
  it('null / vacío / basura = sin dato, nunca 0', () => {
    expect(toAmount(null)).toBeNull();
    expect(toAmount(undefined)).toBeNull();
    expect(toAmount('')).toBeNull();
    expect(toAmount('abc')).toBeNull();
    expect(toAmount(Number.NaN)).toBeNull();
  });
});

describe('poolStatusKind', () => {
  it('active → ok, error → bad', () => {
    expect(poolStatusKind('active')).toBe('ok');
    expect(poolStatusKind('error')).toBe('bad');
  });
  it('inactiva y desconocidos → neutral', () => {
    expect(poolStatusKind('inactive')).toBe('neutral');
    expect(poolStatusKind('otra')).toBe('neutral');
    expect(poolStatusKind(null)).toBe('neutral');
  });
});

describe('connectionEquityTag', () => {
  it('manual gana siempre', () => {
    expect(connectionEquityTag({ connection_values_manual: true, connection_open_positions: 3 })).toBe('manual');
  });
  it('con posiciones abiertas ese día es aproximado', () => {
    expect(connectionEquityTag({ connection_values_manual: false, connection_open_positions: 2 })).toBe('approx');
  });
  it('sin posiciones, o sin calcular, no lleva marca', () => {
    expect(connectionEquityTag({ connection_values_manual: false, connection_open_positions: 0 })).toBeNull();
    expect(connectionEquityTag({ connection_values_manual: false, connection_open_positions: null })).toBeNull();
  });
});

describe('poolTotals', () => {
  it('cuenta y suma igual que antes (texto numérico incluido)', () => {
    const t = poolTotals([
      { status: 'active', balance: 100, balance_liquidez: 60 },
      { status: 'error', balance: '50', balance_liquidez: '50' },
      { status: 'inactive', balance: null, balance_liquidez: null },
    ]);
    expect(t).toEqual({ total: 3, active: 1, inactive: 2, pool: 110, mt5: 150 });
  });
  it('vacío', () => {
    expect(poolTotals([])).toEqual({ total: 0, active: 0, inactive: 0, pool: 0, mt5: 0 });
  });
});

describe('differsFromMt5', () => {
  it('compara como número (texto y número iguales no difieren)', () => {
    expect(differsFromMt5({ balance: '100', balance_liquidez: 100 })).toBe(false);
    expect(differsFromMt5({ balance: 100, balance_liquidez: 60 })).toBe(true);
  });
});
