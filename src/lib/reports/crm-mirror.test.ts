// ─────────────────────────────────────────────────────────────────────────────
// El espejo es MENSUAL, y eso no se disimula.
//
// `crm_monthly_totals` responde por meses. Un informe DIARIO pregunta por un
// día, y esa pregunta no tiene respuesta en esa tabla. Repartir el mes entre
// sus días daría un número plausible y falso — el modo de falla del repo. Estos
// tests fijan que el rango vuelve `null` salvo que sean meses enteros.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  coversWholeMonths,
  monthsBetween,
  loadPropTradingFromMirror,
  loadCrmUsersFromMirror,
} from './crm-mirror';

describe('coversWholeMonths', () => {
  it('un mes completo sí', () => {
    expect(coversWholeMonths('2026-08-01', '2026-08-31')).toBe(true);
    expect(coversWholeMonths('2026-02-01', '2026-02-28')).toBe(true);
    expect(coversWholeMonths('2026-07-01', '2026-08-31')).toBe(true);
  });

  it('un día suelto NO — es la consulta del informe diario', () => {
    expect(coversWholeMonths('2026-08-15', '2026-08-15')).toBe(false);
  });

  it('un mes al que le falta el último día NO', () => {
    expect(coversWholeMonths('2026-08-01', '2026-08-30')).toBe(false);
  });

  it('una semana NO', () => {
    expect(coversWholeMonths('2026-08-24', '2026-08-30')).toBe(false);
  });
});

describe('monthsBetween', () => {
  it('cruza el fin de año', () => {
    expect(monthsBetween('2025-11-01', '2026-01-31')).toEqual([
      { year: 2025, month: 11 },
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
    ]);
  });
});

/** Admin de mentira: sólo `from(...).select(...)` con los encadenados usados. */
function fakeAdmin(rows: unknown[], count = 0) {
  const builder = () => {
    const self: Record<string, unknown> = {};
    for (const m of ['eq', 'in', 'gte', 'lt']) self[m] = () => self;
    self.then = (res: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null, count }).then(res);
    return self;
  };
  return {
    from: () => ({ select: () => builder() }),
  } as unknown as Parameters<typeof loadPropTradingFromMirror>[0];
}

const AGO = { year: 2026, month: 8 };
const JUL = { year: 2026, month: 7 };

describe('loadPropTradingFromMirror', () => {
  const rows = [
    { year: 2026, month: 8, metric: 'propfirm_sales', amount: '11981.70', tx_count: 14 },
    { year: 2026, month: 8, metric: 'propfirm_withdrawals', amount: '2819.04', tx_count: 3 },
    { year: 2026, month: 7, metric: 'propfirm_sales', amount: '14645.20', tx_count: 20 },
    { year: 2026, month: 7, metric: 'propfirm_withdrawals', amount: '5511.98', tx_count: 4 },
  ];

  it('el mes sale de la tabla, con las cifras medidas de agosto 2026', async () => {
    const res = await loadPropTradingFromMirror(
      fakeAdmin(rows), 'c1', '2026-08-15', '2026-08-15', AGO, JUL,
    );
    expect(res.total_sales_month).toBeCloseTo(11_981.70, 2);
    expect(res.pnl_month).toBeCloseTo(11_981.70 - 2_819.04, 2);
    expect(res.pnl_prev_month).toBeCloseTo(14_645.20 - 5_511.98, 2);
    expect(res.connected).toBe(true);
  });

  it('un DÍA suelto no tiene respuesta mensual: el rango vuelve null, no cero', async () => {
    const res = await loadPropTradingFromMirror(
      fakeAdmin(rows), 'c1', '2026-08-15', '2026-08-15', AGO, JUL,
    );
    expect(res.total_sales_range).toBeNull();
    expect(res.prop_withdrawals_range).toBeNull();
    expect(res.prop_withdrawals_count_range).toBeNull();
    expect(res.pnl_range).toBeNull();
  });

  it('un rango de meses ENTEROS sí se puede sumar', async () => {
    const res = await loadPropTradingFromMirror(
      fakeAdmin(rows), 'c1', '2026-07-01', '2026-08-31', AGO, JUL,
    );
    expect(res.total_sales_range).toBeCloseTo(11_981.70 + 14_645.20, 2);
    expect(res.prop_withdrawals_count_range).toBe(3 + 4);
  });

  it('«Productos vendidos» NO se inventa: el espejo no guarda el desglose', async () => {
    const res = await loadPropTradingFromMirror(
      fakeAdmin(rows), 'c1', '2026-08-01', '2026-08-31', AGO, JUL,
    );
    // `null`, nunca `[]`: una lista vacía se lee como «no se vendió nada».
    expect(res.products).toBeNull();
  });

  it('sin ninguna fila la sección NO está conectada — no son ceros', async () => {
    const res = await loadPropTradingFromMirror(
      fakeAdmin([]), 'c1', '2026-08-01', '2026-08-31', AGO, JUL,
    );
    expect(res.connected).toBe(false);
    expect(res.total_sales_month).toBeNull();
    expect(res.pnl_month).toBeNull();
  });

  it('`amount` NULL en la tabla es «no se pudo calcular», no cero', async () => {
    const res = await loadPropTradingFromMirror(
      fakeAdmin([{ year: 2026, month: 8, metric: 'propfirm_sales', amount: null, tx_count: 0 }]),
      'c1', '2026-08-01', '2026-08-31', AGO, JUL,
    );
    expect(res.total_sales_month).toBeNull();
    expect(res.pnl_month).toBeNull();
  });
});

describe('loadCrmUsersFromMirror', () => {
  it('sin ningún usuario en el espejo la sección no está conectada', async () => {
    const res = await loadCrmUsersFromMirror(
      fakeAdmin([], 0) as never, 'c1', '2026-08-15', '2026-08-15', '2026-08-01', '2026-08-31',
    );
    expect(res.total_users).toBe(0);
    // 0 usuarios totales = no hay espejo. Mostrar «0 altas» sería afirmar que
    // no se registró nadie, que es otra cosa.
    expect(res.connected).toBe(false);
    expect(res.isMock).toBe(false);
  });

  it('con espejo cargado devuelve los conteos y se declara conectada', async () => {
    const res = await loadCrmUsersFromMirror(
      fakeAdmin([], 21_680) as never, 'c1', '2026-08-15', '2026-08-15', '2026-08-01', '2026-08-31',
    );
    expect(res.total_users).toBe(21_680);
    expect(res.connected).toBe(true);
  });
});
