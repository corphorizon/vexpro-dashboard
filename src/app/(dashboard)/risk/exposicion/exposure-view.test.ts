import { describe, expect, it } from 'vitest';
import type { MarginRow } from '@/lib/mt5-sync/risk-query';
import { marginLevelText, marginRows, shareWidth } from './exposure-view';

const row = (login: number, level: number | null): MarginRow => ({
  login,
  email: null,
  family: 'STANDARD',
  group_name: null,
  equity: 100,
  balance: 100,
  margin: 50,
  margin_free: 50,
  margin_level: level,
  floating: 0,
  unit: 'account_currency',
  is_virtual: false,
});

describe('marginRows', () => {
  it('cada fila recuerda de qué lista vino; críticas primero', () => {
    const rows = marginRows([row(1, 80)], [row(2, 150), row(3, 190)]);
    expect(rows.map((r) => [r.login, r.list])).toEqual([
      [1, 'critical'],
      [2, 'watch'],
      [3, 'watch'],
    ]);
  });
  it('un nivel null en la lista crítica sigue siendo crítico por su lista, no por un 0 inventado', () => {
    const [r] = marginRows([row(1, null)], []);
    expect(r.list).toBe('critical');
    expect(marginLevelText(r.margin_level)).toBe('—');
  });
  it('tolera listas ausentes', () => {
    expect(marginRows(undefined, null)).toEqual([]);
  });
});

describe('marginLevelText', () => {
  it('2 decimales: un 99,96 crítico no se lee «100 %»', () => {
    expect(marginLevelText(99.96)).toBe('99.96 %');
    expect(marginLevelText(1500)).toBe('1,500.00 %');
  });
});

describe('shareWidth', () => {
  it('acota a 0–100 y no dibuja con un share no finito', () => {
    expect(shareWidth(42.5)).toBe(42.5);
    expect(shareWidth(140)).toBe(100);
    expect(shareWidth(-3)).toBe(0);
    expect(shareWidth(Number.NaN)).toBeNull();
    expect(shareWidth(null)).toBeNull();
  });
});
