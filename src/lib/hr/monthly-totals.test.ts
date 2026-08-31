import { describe, it, expect } from 'vitest';
import {
  totalesDe,
  totalesGenerales,
  totalesPorPerfil,
  type MonthlyResultRow,
} from './monthly-totals';

const fila = (over: Partial<MonthlyResultRow> = {}): MonthlyResultRow => ({
  profile_id: 'p1',
  period_id: 'per1',
  net_deposit_current: 0,
  net_deposit_total: 0,
  pnl_current: 0,
  commissions_earned: 0,
  bonus: 0,
  salary_paid: 0,
  total_earned: 0,
  ...over,
});

describe('totales por perfil', () => {
  it('sólo suma los períodos que el selector dejó pasar', () => {
    const rows = [
      fila({ period_id: 'per1', total_earned: 100 }),
      fila({ period_id: 'per2', total_earned: 900 }),
    ];
    expect(totalesDe(totalesPorPerfil(rows, ['per1']), 'p1').total).toBe(100);
    expect(totalesDe(totalesPorPerfil(rows, ['per1', 'per2']), 'p1').total).toBe(1000);
    expect(totalesDe(totalesPorPerfil(rows, []), 'p1').total).toBe(0);
  });

  it('acumula varias filas del mismo perfil (una por head)', () => {
    const rows = [
      fila({ commissions_earned: 50, bonus: 10 }),
      fila({ commissions_earned: 25, bonus: 5 }),
    ];
    const tot = totalesDe(totalesPorPerfil(rows, ['per1']), 'p1');
    expect(tot.commissions).toBe(75);
    expect(tot.bonus).toBe(15);
  });

  it('un perfil sin filas NO está en el Map (el llamador decide qué mostrar)', () => {
    const m = totalesPorPerfil([fila()], ['per1']);
    expect(m.has('otro')).toBe(false);
    expect(totalesDe(m, 'otro').total).toBe(0);
  });

  it('el total general es la suma de todos los perfiles', () => {
    const rows = [
      fila({ profile_id: 'a', total_earned: 100, salary_paid: 10 }),
      fila({ profile_id: 'b', total_earned: 200, salary_paid: 20 }),
    ];
    const g = totalesGenerales(totalesPorPerfil(rows, ['per1']));
    expect(g.total).toBe(300);
    expect(g.salary).toBe(30);
  });

  it('un valor negativo NO se recorta a cero (una comisión negativa es deuda)', () => {
    const g = totalesGenerales(totalesPorPerfil([fila({ total_earned: -40 })], ['per1']));
    expect(g.total).toBe(-40);
  });
});
