import { describe, expect, it } from 'vitest';
import { ALL_MONTHS, closingBalance, filterByMonth, monthKeyOf, monthsByYear } from './ledger-month-filter';

const rows = [
  { id: 'a', date: '2026-08-31' },
  { id: 'b', date: '2026-09-01' },
  { id: 'c', date: '2026-09-15' },
  { id: 'd', date: '2026-09-15' },
  { id: 'e', date: '2025-12-31' },
];

describe('monthKeyOf', () => {
  it('toma el mes del texto, sin pasar por la zona horaria', () => {
    // En UTC-3, new Date('2026-09-01').getMonth() es agosto: éste es el bug.
    expect(monthKeyOf('2026-09-01')).toBe('2026-09');
    expect(monthKeyOf('2026-09-01T00:00:00Z')).toBe('2026-09');
  });
  it('null para lo que no es fecha (no inventa un mes)', () => {
    expect(monthKeyOf('')).toBeNull();
    expect(monthKeyOf(null)).toBeNull();
    expect(monthKeyOf('01/09/2026')).toBeNull();
  });
});

describe('monthsByYear', () => {
  it('agrupa los meses con datos por año', () => {
    const m = monthsByYear(rows);
    expect([...m.keys()].sort()).toEqual([2025, 2026]);
    expect([...m.get(2026)!].sort((a, b) => a - b)).toEqual([8, 9]);
    expect([...m.get(2025)!]).toEqual([12]);
  });
  it('ignora fechas inválidas en vez de crear un año NaN', () => {
    const m = monthsByYear([{ date: 'basura' }]);
    expect(m.size).toBe(0);
  });
});

describe('filterByMonth', () => {
  it('total devuelve todo', () => {
    expect(filterByMonth(rows, ALL_MONTHS)).toHaveLength(5);
  });
  it('filtra el mes exacto, sin arrastrar el último día del anterior', () => {
    expect(filterByMonth(rows, '2026-09').map((r) => r.id)).toEqual(['b', 'c', 'd']);
  });
  it('un mes sin filas da lista vacía', () => {
    expect(filterByMonth(rows, '2026-10')).toEqual([]);
  });
});

describe('closingBalance', () => {
  const map = new Map([
    ['a', 100],
    ['b', 150],
    ['c', 120],
    ['d', 90],
    ['e', 10],
  ]);
  it('es el saldo de la última fila por fecha; a igual fecha, la última en llegar', () => {
    expect(closingBalance(rows, map)).toBe(90);
    expect(closingBalance(filterByMonth(rows, '2026-08'), map)).toBe(100);
  });
  it('sin filas es null, no 0', () => {
    expect(closingBalance([], map)).toBeNull();
  });
  it('una fila sin saldo calculado es null, no 0', () => {
    expect(closingBalance([{ id: 'zz', date: '2027-01-01' }], map)).toBeNull();
  });
});
