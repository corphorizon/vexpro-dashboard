// ─────────────────────────────────────────────────────────────────────────────
// expenses-view — las decisiones de /egresos que no son de dibujo, puras para
// testearlas sin DOM (mismo patrón que ordenes-pago/orders-view.ts).
//
// POR QUÉ (2026-10-12, migración «Libro mayor»):
//   · Estado: la tabla decidía «Pagado / Pendiente» con `pending === 0` en la
//     página, y el PDF de cierre lo decide con `expenseStatus` (pagado /
//     pendiente / PARCIAL). Dos reglas para el mismo badge: un egreso de
//     $1.000 con $400 pagados se veía «Pendiente» en pantalla y «Parcial» en
//     el papel. Ahora el estado sale de `expenseStatus` y el color de
//     `statusKind('expense', …)` — el mismo registro que el PDF.
//   · Filtros por estado: salen de las claves de STATUS_DOMAINS.expense
//     (registro único). Un estado nuevo aparece solo; el test itera el registro.
//   · Grupos por categoría: el orden y la clave («sin categoría» incluida) son
//     los de `buildExpenses` (reports/company-report.ts), que es lo que usan el
//     reporte de empresa y su CSV. No se reescribe la agrupación: si la de acá
//     difiriera, la pantalla y el reporte mostrarían subtotales distintos.
//   · KPI «Fijos»: `is_fixed` es opcional en el tipo. Si NINGUNA fila trae el
//     campo, no sabemos cuánto es fijo — eso es «—», no $0.00 (reglas §1.3).
//
// DESCARTADO:
//   · Contar por estado sobre TODO el período ignorando búsqueda y chips: el
//     Segmented diría «Pendientes 4» con la tabla mostrando 1 (mismo criterio
//     que orders-view).
//   · Ordenar los grupos alfabéticamente: el reporte los ordena por monto y la
//     pantalla tiene que leerse igual que el papel.
// ─────────────────────────────────────────────────────────────────────────────

import type { Expense } from '@/lib/types';
import { expenseStatus, type ExpenseStatus } from '@/lib/monthly-close-pdf-data';
import { buildExpenses, UNCATEGORIZED } from '@/lib/reports/company-report';
import { STATUS_DOMAINS } from '@/components/ui/status-kind';

export { UNCATEGORIZED };

export type ExpenseFilter = 'all' | ExpenseStatus;
export type SortState = 'default' | 'desc' | 'asc';

/** Estados del dominio `expense`, en el orden del registro (status-kind.ts). */
export const EXPENSE_STATUSES = Object.keys(STATUS_DOMAINS.expense) as ExpenseStatus[];

/** «Todos» + un filtro por estado. */
export const EXPENSE_FILTERS: readonly ExpenseFilter[] = ['all', ...EXPENSE_STATUSES];

type StatusInput = Pick<Expense, 'amount' | 'paid' | 'pending'>;

/** Estado de un egreso: la MISMA función que el PDF de cierre. */
export function rowStatus(e: StatusInput): ExpenseStatus {
  return expenseStatus(e);
}

/** Clave de categoría: la de buildExpenses (trim, vacío → UNCATEGORIZED). */
export function categoryKey(e: Pick<Expense, 'category'>): string {
  return e.category?.trim() || UNCATEGORIZED;
}

// ── Chips por categoría ─────────────────────────────────────────────────────

export interface CategoryChip {
  key: string;
  count: number;
}

/** Categorías con su cantidad de egresos, en el orden del reporte (monto desc). */
export function categoryChips(expenses: Expense[]): CategoryChip[] {
  return buildExpenses(expenses).categories.map((c) => ({ key: c.category, count: c.count }));
}

// ── Filtro ──────────────────────────────────────────────────────────────────

export interface ExpenseFilters {
  status: ExpenseFilter;
  query: string;
  /** Claves de categoría (categoryKey). Vacío = todas. */
  categories: string[];
}

function matchesQuery(e: Expense, q: string): boolean {
  if (!q) return true;
  // Busca también en la descripción de la OP y en la referencia: son texto
  // visible en la tabla, y lo visible tiene que ser buscable.
  return (
    e.concept.toLowerCase().includes(q) ||
    (e.payment_order_description ?? '').toLowerCase().includes(q) ||
    (e.reference ?? '').toLowerCase().includes(q)
  );
}

/** Búsqueda + categorías, antes del estado (base de los conteos del Segmented). */
export function applySearchAndCategories(expenses: Expense[], query: string, categories: string[]): Expense[] {
  const q = query.trim().toLowerCase();
  return expenses.filter(
    (e) => matchesQuery(e, q) && (categories.length === 0 || categories.includes(categoryKey(e))),
  );
}

/** Conteo por filtro de estado sobre una base ya filtrada. */
export function statusCounts(expenses: StatusInput[]): Record<ExpenseFilter, number> {
  const out = Object.fromEntries(EXPENSE_FILTERS.map((f) => [f, 0])) as Record<ExpenseFilter, number>;
  for (const e of expenses) {
    out.all += 1;
    out[rowStatus(e)] += 1;
  }
  return out;
}

/**
 * Orden dentro de un grupo. Por defecto fecha DESCENDENTE (dueño, 2026-09-25)
 * con los egresos SIN fecha al final, conservando su orden de carga (el sort
 * es estable). Jamás se les inventa una fecha — ver Expense.expense_date.
 */
export function sortExpenses<T extends Pick<Expense, 'amount' | 'expense_date'>>(rows: T[], sort: SortState): T[] {
  const out = [...rows];
  if (sort === 'desc') return out.sort((a, b) => b.amount - a.amount);
  if (sort === 'asc') return out.sort((a, b) => a.amount - b.amount);
  return out.sort((a, b) => {
    if (!a.expense_date && !b.expense_date) return 0;
    if (!a.expense_date) return 1;
    if (!b.expense_date) return -1;
    return b.expense_date.localeCompare(a.expense_date);
  });
}

/**
 * Filas listas para la tabla agrupada: filtradas y ordenadas por grupo
 * (categorías en el orden de buildExpenses) y, dentro, por `sort`. FinTable
 * agrupa en orden de primera aparición, así que este orden ES el de los grupos.
 */
export function groupedExpenseRows(expenses: Expense[], filters: ExpenseFilters, sort: SortState): Expense[] {
  const base = applySearchAndCategories(expenses, filters.query, filters.categories);
  const filtered = filters.status === 'all' ? base : base.filter((e) => rowStatus(e) === filters.status);
  const order = buildExpenses(filtered).categories.map((c) => c.category);
  const byKey = new Map<string, Expense[]>();
  for (const e of filtered) {
    const k = categoryKey(e);
    const bucket = byKey.get(k);
    if (bucket) bucket.push(e);
    else byKey.set(k, [e]);
  }
  return order.flatMap((k) => sortExpenses(byKey.get(k) ?? [], sort));
}

// ── KPIs ────────────────────────────────────────────────────────────────────

export interface FixedSummary {
  /** Suma de los fijos; null si ninguna fila dice si es fija o no. */
  sum: number | null;
  /** Egresos marcados como fijos. */
  count: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function fixedSummary(expenses: Pick<Expense, 'amount' | 'is_fixed'>[]): FixedSummary {
  if (expenses.length === 0) return { sum: 0, count: 0 };
  const known = expenses.some((e) => typeof e.is_fixed === 'boolean');
  let sum = 0;
  let count = 0;
  for (const e of expenses) {
    if (e.is_fixed === true) {
      sum += Number(e.amount) || 0;
      count += 1;
    }
  }
  return { sum: known ? round2(sum) : null, count };
}

/** Totales de un conjunto de filas (pie de la tabla): los de buildExpenses. */
export function expenseTotals(rows: Pick<Expense, 'category' | 'amount' | 'paid' | 'pending'>[]): {
  amount: number;
  paid: number;
  pending: number;
} {
  const r = buildExpenses(rows);
  return { amount: r.total, paid: r.paid, pending: r.pending };
}
