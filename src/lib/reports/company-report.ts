// ─────────────────────────────────────────────────────────────────────────────
// Reporte de una empresa de servicios ('company') — contrato compartido.
//
// El reporte de broker responde "cuánto entró y salió de las cuentas de los
// clientes". Una consultora no tiene esa pregunta: la suya es "a quién le
// facturé, cuánto me pagaron, qué gasté y qué quedó". Este módulo arma esas
// cuatro respuestas UNA sola vez y las tres salidas (pantalla, CSV, PDF) leen
// el mismo objeto — si cada una calculara lo suyo, el PDF y la pantalla se
// contradirían en cuanto alguien tocara una fórmula.
//
// No reimplementa nada: la facturación por cliente sale de src/lib/clients.ts
// y el dónde-está-la-plata de src/lib/cash-locations.ts.
//
// Import-safe desde cliente y servidor: no toca Supabase ni React.
// ─────────────────────────────────────────────────────────────────────────────

import { totalsOf, UNASSIGNED_CLIENT_KEY, type ClientCard } from '@/lib/clients';
import {
  groupByType,
  groupByUnit,
  summarize,
  type AllocatedLocation,
  type BusinessUnit,
  type CashLocation,
  type CashSummary,
  type LocationType,
} from '@/lib/cash-locations';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ─── Períodos que toca el rango de fechas ────────────────────────────────

export interface PeriodRef {
  id: string;
  year: number;
  month: number;
  label: string | null;
}

/** Orden cronológico de un mes — la misma cuenta que usa la ficha de cliente. */
export function monthOrder(year: number, month: number): number {
  return year * 12 + month;
}

function orderFromISO(iso: string): number | null {
  const [y, m] = iso.split('-').map(Number);
  if (!y || !m) return null;
  return monthOrder(y, m);
}

/**
 * Períodos cuyo mes cae dentro del rango. El reporte se pide por fechas pero
 * la contabilidad de la empresa vive por mes: un rango de 7 días a caballo de
 * dos meses toca los dos, y ocultar el segundo daría un total que no cierra
 * con ninguna otra pantalla.
 */
export function periodsInRange<T extends PeriodRef>(periods: T[], from: string, to: string): T[] {
  const start = orderFromISO(from);
  const end = orderFromISO(to);
  if (start === null || end === null) return [];
  const [lo, hi] = start <= end ? [start, end] : [end, start];
  return periods
    .filter((p) => {
      const o = monthOrder(p.year, p.month);
      return o >= lo && o <= hi;
    })
    .sort((a, b) => monthOrder(a.year, a.month) - monthOrder(b.year, b.month));
}

// ─── Facturación ─────────────────────────────────────────────────────────

export interface BillingClientRow {
  key: string;
  name: string;
  billed: number;
  collected: number;
  pending: number;
}

export interface BillingReport {
  billed: number;
  collected: number;
  pending: number;
  clients: BillingClientRow[];
  clientCount: number;
  /** Clientes con saldo por cobrar. */
  withDebt: number;
}

/** Aplana las fichas de cliente al desglose del reporte. El orden ya lo puso
 *  `cardsFromLines`: primero el que más debe. */
export function buildBilling(cards: ClientCard[]): BillingReport {
  const totals = totalsOf(cards);
  return {
    billed: totals.amount,
    collected: totals.received,
    pending: totals.pending,
    clientCount: totals.clients,
    withDebt: totals.withDebt,
    clients: cards.map((c) => ({
      key: c.key,
      name: c.name,
      billed: c.amount,
      collected: c.received,
      pending: c.pending,
    })),
  };
}

export { UNASSIGNED_CLIENT_KEY };

// ─── Egresos ─────────────────────────────────────────────────────────────

/** Sentinel para los egresos sin categoría: la etiqueta la pone quien muestra,
 *  así el CSV, el PDF y la pantalla no inventan cada uno su texto. */
export const UNCATEGORIZED = '__uncategorized__';

export interface ExpenseCategoryRow {
  category: string;
  amount: number;
  paid: number;
  pending: number;
  count: number;
}

export interface ExpensesReport {
  total: number;
  paid: number;
  pending: number;
  categories: ExpenseCategoryRow[];
}

export interface ExpenseLike {
  category: string | null;
  amount: number;
  paid: number;
  pending: number;
}

export function buildExpenses(expenses: ExpenseLike[]): ExpensesReport {
  const byCategory = new Map<string, ExpenseCategoryRow>();
  let total = 0, paid = 0, pending = 0;

  for (const e of expenses) {
    const amount = Number(e.amount) || 0;
    const p = Number(e.paid) || 0;
    const pend = Number(e.pending) || 0;
    total += amount;
    paid += p;
    pending += pend;

    const key = e.category?.trim() || UNCATEGORIZED;
    const row = byCategory.get(key);
    if (row) {
      row.amount += amount;
      row.paid += p;
      row.pending += pend;
      row.count += 1;
    } else {
      byCategory.set(key, { category: key, amount, paid: p, pending: pend, count: 1 });
    }
  }

  return {
    total: round2(total),
    paid: round2(paid),
    pending: round2(pending),
    categories: [...byCategory.values()]
      .map((r) => ({ ...r, amount: round2(r.amount), paid: round2(r.paid), pending: round2(r.pending) }))
      .sort((a, b) => b.amount - a.amount),
  };
}

// ─── Resultado ───────────────────────────────────────────────────────────

/** Los campos de SaldoInfo que el reporte necesita. Se declara acá (y no se
 *  importa de data-context) para que este módulo siga siendo import-safe
 *  desde el servidor. */
export interface SaldoChainSlice {
  ingresosNetos: number;
  egresosNetos: number;
  saldoAFavor: number;
  reserveThisPeriod: number;
  montoDistribuir: number;
}

export interface ResultReport {
  /** Lo efectivamente cobrado a clientes en el rango. */
  collected: number;
  /** Lo efectivamente pagado de egresos en el rango. */
  paidExpenses: number;
  /** Cobrado − pagado: el resultado de caja, sin promesas de ninguno de los dos lados. */
  cashResult: number;
  ingresosNetos: number;
  egresosNetos: number;
  saldoAFavor: number;
  reserveThisPeriod: number;
  montoDistribuir: number;
}

export function buildResult(
  collected: number,
  paidExpenses: number,
  chain: SaldoChainSlice[],
): ResultReport {
  let ingresosNetos = 0, egresosNetos = 0, saldoAFavor = 0, reserveThisPeriod = 0, montoDistribuir = 0;
  for (const s of chain) {
    ingresosNetos += s.ingresosNetos;
    egresosNetos += s.egresosNetos;
    saldoAFavor += s.saldoAFavor;
    reserveThisPeriod += s.reserveThisPeriod;
    montoDistribuir += s.montoDistribuir;
  }
  return {
    collected: round2(collected),
    paidExpenses: round2(paidExpenses),
    cashResult: round2(collected - paidExpenses),
    ingresosNetos: round2(ingresosNetos),
    egresosNetos: round2(egresosNetos),
    saldoAFavor: round2(saldoAFavor),
    reserveThisPeriod: round2(reserveThisPeriod),
    montoDistribuir: round2(montoDistribuir),
  };
}

// ─── Dónde está el dinero ────────────────────────────────────────────────

export interface CashReport {
  summary: CashSummary;
  byType: Array<{ type: LocationType; total: number; count: number }>;
  /**
   * Desglose por unidad ya PRORRATEADO: una ubicación compartida aparece en
   * cada unidad dueña con la parte que le toca (`balance`) y el saldo entero
   * aparte (`fullBalance`). Tipar esto como `CashLocation` escondía que
   * `balance` ya no era el saldo completo, y las tres salidas mostraban la
   * ubicación entera bajo una sola unidad.
   */
  byUnit: Array<{ unit: BusinessUnit | null; locations: AllocatedLocation[]; total: number }>;
}

/**
 * Etiqueta de una ubicación en el desglose. Cuando la unidad se queda con una
 * parte se dice cuál: sin eso, dos filas de "Wallet Externa" con montos
 * distintos parecen un error de carga en vez de un reparto.
 */
export function allocationLabel(
  location: { label: string; share: number },
  unit: BusinessUnit | null,
): string {
  const base = unit ? `${location.label} (${unit.name})` : location.label;
  return location.share < 0.9999 ? `${base} · ${formatShare(location.share)}%` : base;
}

/** Porcentaje sin decimales de más: 60, no 60.00; 33.33 cuando hace falta. */
export function formatShare(share: number): string {
  const pct = share * 100;
  return pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2);
}

export function buildCash(locations: CashLocation[], units: BusinessUnit[]): CashReport {
  return {
    summary: summarize(locations, units),
    byType: groupByType(locations),
    byUnit: groupByUnit(locations, units),
  };
}

// ─── Reporte completo ────────────────────────────────────────────────────

export interface CompanyReport {
  range: { from: string; to: string };
  /** Meses que el rango toca, en orden. Vacío = el rango cae fuera de la contabilidad cargada. */
  periods: Array<{ id: string; label: string }>;
  billing: BillingReport;
  expenses: ExpensesReport;
  result: ResultReport;
  cash: CashReport;
}

// ─── CSV ─────────────────────────────────────────────────────────────────

/** Mismo formato Sección/Métrica/Valor que el CSV del reporte de broker, para
 *  que quien recibe los dos archivos no tenga que aprender dos planillas. */
export function companyReportCsvRows(report: CompanyReport): (string | number)[][] {
  const unassigned = 'Sin cliente';
  const uncategorized = 'Sin categoría';
  return [
    ['Período', 'Desde', report.range.from],
    ['Período', 'Hasta', report.range.to],
    ['Período', 'Meses incluidos', report.periods.map((p) => p.label).join(' · ') || '—'],

    ['Facturación', 'Total facturado', report.billing.billed],
    ['Facturación', 'Cobrado', report.billing.collected],
    ['Facturación', 'Por cobrar', report.billing.pending],
    ['Facturación', 'Clientes', report.billing.clientCount],
    ['Facturación', 'Clientes con deuda', report.billing.withDebt],
    ...report.billing.clients.map((c) => [
      'Facturación · Clientes',
      c.key === UNASSIGNED_CLIENT_KEY ? unassigned : c.name,
      c.billed,
    ] as (string | number)[]),

    ['Egresos', 'Total', report.expenses.total],
    ['Egresos', 'Pagado', report.expenses.paid],
    ['Egresos', 'Pendiente', report.expenses.pending],
    ...report.expenses.categories.map((c) => [
      'Egresos · Categorías',
      c.category === UNCATEGORIZED ? uncategorized : c.category,
      c.amount,
    ] as (string | number)[]),

    ['Resultado', 'Cobrado', report.result.collected],
    ['Resultado', 'Egresos pagados', report.result.paidExpenses],
    ['Resultado', 'Resultado de caja', report.result.cashResult],
    ['Resultado', 'Ingresos netos', report.result.ingresosNetos],
    ['Resultado', 'Egresos netos', report.result.egresosNetos],
    ['Resultado', 'Saldo a favor', report.result.saldoAFavor],
    ['Resultado', 'Reserva del período', report.result.reserveThisPeriod],
    ['Resultado', 'Monto a distribuir', report.result.montoDistribuir],

    ['Dinero', 'Disponible', report.cash.summary.liquid],
    ['Dinero', 'Prestado', report.cash.summary.lent],
    ['Dinero', 'Total', report.cash.summary.total],
    ...report.cash.byUnit.flatMap((g) =>
      g.locations.map((l) => [
        'Dinero · Ubicaciones',
        allocationLabel(l, g.unit),
        l.balance,
      ] as (string | number)[]),
    ),
  ];
}
