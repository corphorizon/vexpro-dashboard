import { describe, expect, it } from 'vitest';
import { byResponsible, capitalPlacedAtEnd, returnPct } from './investments-view';

const row = (date: string, responsible: string | null, deposit: number, withdrawal: number, profit: number, concept = '') =>
  ({ date, responsible, deposit, withdrawal, profit, concept });

describe('byResponsible', () => {
  it('agrupa, suma con la fórmula del saldo y ordena por saldo', () => {
    const out = byResponsible([
      row('2026-01-01', 'Ana', 1000, 0, 0),
      row('2026-02-01', 'Ana', 0, 0, 50),
      row('2026-01-05', 'Beto', 5000, 0, 0),
    ]);
    expect(out.rows.map((r) => r.responsible)).toEqual(['Beto', 'Ana']);
    expect(out.rows[1]).toMatchObject({ deposits: 1000, profit: 50, balance: 1050, count: 2 });
  });
  it('cuenta las filas sin responsable en vez de callarlas', () => {
    const out = byResponsible([row('2026-01-01', null, 1, 0, 0), row('2026-01-01', '  ', 1, 0, 0), row('2026-01-01', 'Ana', 1, 0, 0)]);
    expect(out.unassigned).toBe(2);
    expect(out.rows).toHaveLength(1);
  });
  it('recorta espacios: «Ana » y «Ana» son la misma persona', () => {
    const out = byResponsible([row('2026-01-01', 'Ana ', 1, 0, 0), row('2026-01-01', 'Ana', 1, 0, 0)]);
    expect(out.rows).toHaveLength(1);
  });
});

describe('capitalPlacedAtEnd', () => {
  const all = [
    row('2026-01-10', 'A', 1000, 0, 0),
    row('2026-02-10', 'A', 0, 200, 0, 'devolución'),
    row('2026-03-10', 'A', 500, 0, 0),
  ];
  it('con un mes, toma todo lo anterior y ese mes', () => {
    expect(capitalPlacedAtEnd(all, '2026-02')).toBe(800);
  });
  it('con total, todo el histórico', () => {
    expect(capitalPlacedAtEnd(all, 'total')).toBe(1300);
  });
  it('un cobro de ganancia NO resta capital', () => {
    expect(capitalPlacedAtEnd([...all, row('2026-03-20', 'A', 0, 100, 0, 'ganancia')], 'total')).toBe(1300);
  });
});

describe('returnPct', () => {
  it('ganancia / capital, en % con un decimal', () => {
    expect(returnPct(41, 1000)).toBe(4.1);
    expect(returnPct(-25, 1000)).toBe(-2.5);
  });
  it('sin capital positivo no hay rendimiento: null, no 0 % ni infinito', () => {
    expect(returnPct(100, 0)).toBeNull();
    expect(returnPct(100, -50)).toBeNull();
    expect(returnPct(Number.NaN, 100)).toBeNull();
  });
});
