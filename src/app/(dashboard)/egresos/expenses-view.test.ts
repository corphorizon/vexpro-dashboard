// /egresos: estado del registro único, conteos, filas agrupadas por categoría
// en el orden del reporte, y «Fijos» que no inventa $0.00.
import { describe, it, expect } from 'vitest';
import type { Expense } from '@/lib/types';
import { STATUS_DOMAINS, statusKind } from '@/components/ui/status-kind';
import { buildExpenses } from '@/lib/reports/company-report';
import { groupRows } from '@/components/ui/fin-table-model';
import {
  EXPENSE_FILTERS,
  EXPENSE_STATUSES,
  UNCATEGORIZED,
  applySearchAndCategories,
  categoryChips,
  categoryKey,
  expenseTotals,
  fixedSummary,
  groupedExpenseRows,
  rowStatus,
  sortExpenses,
  statusCounts,
} from './expenses-view';

let seq = 0;
function exp(p: Partial<Expense>): Expense {
  seq += 1;
  return {
    id: `e${seq}`,
    period_id: 'p1',
    company_id: 'c1',
    concept: `Egreso ${seq}`,
    amount: 100,
    paid: 100,
    pending: 0,
    category: null,
    sort_order: seq,
    ...p,
  };
}

const ROWS: Expense[] = [
  exp({ id: 'a', concept: 'Alquiler oficina', category: 'Oficina', amount: 1000, paid: 1000, pending: 0, expense_date: '2026-09-05', is_fixed: true }),
  exp({ id: 'b', concept: 'Luz', category: 'Oficina', amount: 200, paid: 0, pending: 200, expense_date: '2026-09-20', is_fixed: false }),
  exp({ id: 'c', concept: 'OP-2026-7 · Abogado', category: 'Legales', amount: 1500, paid: 600, pending: 900, payment_order_description: 'Honorarios septiembre', reference: '0xabc', is_fixed: false }),
  exp({ id: 'd', concept: 'Café', category: '  ', amount: 50, paid: 50, pending: 0, is_fixed: false }),
  exp({ id: 'e', concept: 'Internet', category: 'Oficina', amount: 80, paid: 80, pending: 0, expense_date: null, is_fixed: true }),
];

describe('estado de un egreso — registro único', () => {
  it('los filtros salen de STATUS_DOMAINS.expense (un estado nuevo aparece solo)', () => {
    expect(EXPENSE_STATUSES).toEqual(Object.keys(STATUS_DOMAINS.expense));
    expect(EXPENSE_FILTERS).toEqual(['all', ...Object.keys(STATUS_DOMAINS.expense)]);
  });

  it('pagado / pendiente / parcial con la regla del PDF, y su color por statusKind', () => {
    expect(rowStatus(ROWS[0])).toBe('pagado');
    expect(rowStatus(ROWS[1])).toBe('pendiente');
    expect(rowStatus(ROWS[2])).toBe('parcial');
    expect(statusKind('expense', rowStatus(ROWS[0]))).toBe('ok');
    expect(statusKind('expense', rowStatus(ROWS[1]))).toBe('pend');
    // Parcial NO es «ok»: falta pagar una parte.
    expect(statusKind('expense', rowStatus(ROWS[2]))).toBe('pend');
  });

  it('cada estado del registro tiene un color que no es neutro por accidente', () => {
    for (const s of EXPENSE_STATUSES) expect(statusKind('expense', s)).not.toBe('neutral');
  });
});

describe('conteos por estado', () => {
  it('cuentan sobre la base que reciben y suman «all»', () => {
    const c = statusCounts(ROWS);
    expect(c).toEqual({ all: 5, pagado: 3, pendiente: 1, parcial: 1 });
    expect(c.pagado + c.pendiente + c.parcial).toBe(c.all);
  });

  it('una lista vacía da ceros (cero de verdad: no hay egresos)', () => {
    expect(statusCounts([])).toEqual({ all: 0, pagado: 0, pendiente: 0, parcial: 0 });
  });

  it('respetan búsqueda y categorías (no cuentan lo que la tabla no muestra)', () => {
    const base = applySearchAndCategories(ROWS, '', ['Oficina']);
    expect(statusCounts(base)).toEqual({ all: 3, pagado: 2, pendiente: 1, parcial: 0 });
  });
});

describe('búsqueda y categorías', () => {
  it('busca en concepto, descripción de la OP y referencia', () => {
    expect(applySearchAndCategories(ROWS, 'honorarios', []).map((e) => e.id)).toEqual(['c']);
    expect(applySearchAndCategories(ROWS, '0XABC', []).map((e) => e.id)).toEqual(['c']);
    expect(applySearchAndCategories(ROWS, '  luz ', []).map((e) => e.id)).toEqual(['b']);
  });

  it('una búsqueda que no coincide no devuelve nada (no ignora el filtro)', () => {
    expect(applySearchAndCategories(ROWS, 'zzz', [])).toEqual([]);
  });

  it('categoría vacía o en blanco cae en el centinela del reporte', () => {
    expect(categoryKey({ category: '  ' })).toBe(UNCATEGORIZED);
    expect(categoryKey({ category: null })).toBe(UNCATEGORIZED);
    expect(categoryKey({ category: ' Oficina ' })).toBe('Oficina');
  });

  it('chips: las categorías de buildExpenses, con su conteo, en orden de monto', () => {
    expect(categoryChips(ROWS)).toEqual([
      { key: 'Legales', count: 1 },
      { key: 'Oficina', count: 3 },
      { key: UNCATEGORIZED, count: 1 },
    ]);
    expect(categoryChips(ROWS).map((c) => c.key)).toEqual(buildExpenses(ROWS).categories.map((c) => c.category));
  });
});

describe('filas agrupadas con subtotal', () => {
  it('ordenadas por grupo (orden del reporte) y, dentro, fecha desc con las sin fecha al final', () => {
    const rows = groupedExpenseRows(ROWS, { status: 'all', query: '', categories: [] }, 'default');
    expect(rows.map((e) => e.id)).toEqual(['c', 'b', 'a', 'e', 'd']);
  });

  it('los subtotales de FinTable sobre estas filas coinciden con los del reporte', () => {
    const rows = groupedExpenseRows(ROWS, { status: 'all', query: '', categories: [] }, 'default');
    const groups = groupRows(rows, categoryKey, [{ key: 'amount', value: (e) => e.amount }]);
    const report = buildExpenses(ROWS).categories;
    expect(groups.map((g) => [g.key, g.subtotals.amount.sum, g.rows.length])).toEqual(
      report.map((c) => [c.category, c.amount, c.count]),
    );
    // Oficina: 1000 + 200 + 80
    expect(groups.find((g) => g.key === 'Oficina')!.subtotals.amount.sum).toBe(1280);
  });

  it('filtrar por estado deja sólo ese estado y re-ordena los grupos por lo que queda', () => {
    const rows = groupedExpenseRows(ROWS, { status: 'pagado', query: '', categories: [] }, 'default');
    expect(rows.map((e) => e.id)).toEqual(['a', 'e', 'd']);
    expect(rows.every((e) => rowStatus(e) === 'pagado')).toBe(true);
  });

  it('un filtro que no coincide da una tabla vacía, no la tabla entera', () => {
    expect(groupedExpenseRows(ROWS, { status: 'parcial', query: 'luz', categories: [] }, 'default')).toEqual([]);
    expect(groupedExpenseRows(ROWS, { status: 'all', query: '', categories: ['No existe'] }, 'default')).toEqual([]);
  });

  it('orden por monto dentro del grupo (asc / desc)', () => {
    const oficina = { status: 'all' as const, query: '', categories: ['Oficina'] };
    expect(groupedExpenseRows(ROWS, oficina, 'desc').map((e) => e.amount)).toEqual([1000, 200, 80]);
    expect(groupedExpenseRows(ROWS, oficina, 'asc').map((e) => e.amount)).toEqual([80, 200, 1000]);
  });

  it('sortExpenses no inventa fechas: dos sin fecha conservan su orden de carga', () => {
    const r = sortExpenses(
      [
        { id: '1', amount: 1, expense_date: null },
        { id: '2', amount: 1, expense_date: '2026-09-01' },
        { id: '3', amount: 1, expense_date: undefined },
      ],
      'default',
    );
    expect(r.map((x) => x.id)).toEqual(['2', '1', '3']);
  });

  it('el total del pie es el de buildExpenses sobre las filas visibles', () => {
    const rows = groupedExpenseRows(ROWS, { status: 'all', query: '', categories: ['Oficina'] }, 'default');
    expect(expenseTotals(rows)).toEqual({ amount: 1280, paid: 1080, pending: 200 });
    expect(expenseTotals([])).toEqual({ amount: 0, paid: 0, pending: 0 });
  });
});

describe('KPI «Fijos»', () => {
  it('suma los marcados como fijos', () => {
    expect(fixedSummary(ROWS)).toEqual({ sum: 1080, count: 2 });
  });

  it('si ninguna fila dice si es fija, es «sin dato» (null), nunca $0.00', () => {
    const unknown = ROWS.map((e) => ({ ...e, is_fixed: undefined }));
    expect(fixedSummary(unknown)).toEqual({ sum: null, count: 0 });
  });

  it('con el dato y ningún fijo, es cero de verdad', () => {
    expect(fixedSummary(ROWS.map((e) => ({ ...e, is_fixed: false })))).toEqual({ sum: 0, count: 0 });
  });

  it('un período sin egresos es cero (no hay nada que no sepamos)', () => {
    expect(fixedSummary([])).toEqual({ sum: 0, count: 0 });
  });
});
