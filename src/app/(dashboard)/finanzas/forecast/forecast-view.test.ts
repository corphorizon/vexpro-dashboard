// /finanzas/forecast: «Comprometido sin pagar» no puede decir $0.00 cuando la
// lectura de órdenes falló, y el recorte del endpoint se cuenta (2026-10-12).
import { describe, it, expect } from 'vitest';
import { moneyText } from '@/components/ui/money';
import { COMMITTED_ORDERS_LIMIT, committedSummary, lastCarriedDebt, type ApprovedOrder } from './forecast-view';

const order = (id: string, total: number): ApprovedOrder => ({
  id,
  order_number: `OP-${id}`,
  beneficiary_name: 'Proveedor',
  total,
});

describe('committedSummary', () => {
  it('OK: suma y cuenta las órdenes', () => {
    expect(committedSummary({ status: 'ok', orders: [order('1', 1200), order('2', 300.5)] })).toEqual({
      total: 1500.5,
      count: 2,
      truncated: false,
    });
  });

  it('OK sin órdenes: es un cero real', () => {
    expect(committedSummary({ status: 'ok', orders: [] })).toEqual({ total: 0, count: 0, truncated: false });
  });

  it('falló: null → «—», nunca $0.00', () => {
    const s = committedSummary({ status: 'failed' });
    expect(s).toEqual({ total: null, count: null, truncated: false });
    expect(moneyText(s.total)).toBe('—');
  });

  it('cargando: tampoco es cero', () => {
    expect(committedSummary({ status: 'loading' }).total).toBeNull();
  });

  it('vino el límite exacto: puede haber más (recorte contado)', () => {
    const orders = Array.from({ length: COMMITTED_ORDERS_LIMIT }, (_, i) => order(String(i), 1));
    expect(committedSummary({ status: 'ok', orders }).truncated).toBe(true);
    expect(committedSummary({ status: 'ok', orders: orders.slice(1) }).truncated).toBe(false);
  });
});

describe('lastCarriedDebt', () => {
  it('deuda del último mes con signo de pasivo', () => {
    expect(lastCarriedDebt([{ debtOut: 500 }, { debtOut: 1200 }])).toBe(-1200);
  });

  it('sin deuda: 0', () => {
    expect(lastCarriedDebt([{ debtOut: 500 }, { debtOut: 0 }])).toBe(0);
  });

  it('sin meses proyectados: null (no hay deuda que afirmar)', () => {
    expect(lastCarriedDebt([])).toBeNull();
  });
});
