// ─────────────────────────────────────────────────────────────────────────────
// orders-view — las decisiones del listado de órdenes de pago que no son de
// dibujo, puras para testearlas sin DOM (mismo patrón que balances-view.ts).
//
// POR QUÉ (2026-10-12, migración «Libro mayor»):
//   · Filtros por estado: la lista de filtros era un array escrito a mano en la
//     página y le faltaba «Rechazada» — una orden rechazada sólo aparecía en
//     «Todas», y quien buscaba «qué me rebotaron» no tenía dónde mirar. Ahora
//     se deriva de TRANSITIONS (la máquina de estados, registro único): un
//     estado nuevo aparece como filtro solo, y el test itera sobre el registro.
//   · KPIs: sumaban `o.total` de TODAS las órdenes sin mirar la moneda, y el mes
//     salía de `getMonth()` LOCAL comparado contra un `paid_at` en UTC — una OP
//     pagada el 31 a las 22:00 en Buenos Aires caía en el mes siguiente. Ahora:
//     mes UTC (mismo criterio que `todayUtcISO`), y sólo se suma la moneda de la
//     empresa (USDT ≡ USD, como en el formulario); lo que esté en otra moneda se
//     CUENTA y el KPI lo dice — «no lo sumamos» nunca se ve como «no hay».
//   · Recorte: GET /api/admin/payment-orders corta en 200 filas por defecto
//     (500 como máximo) SIN avisar. Con más órdenes que eso, los KPIs y los
//     conteos salían de una muestra con cara de total. El listado pide el
//     máximo y, si vuelve lleno, `isListTruncated` lo marca para avisarlo.
//
// DESCARTADO:
//   · Un `count: 'exact'` en el endpoint: es el arreglo de fondo, pero toca la
//     API (fuera de esta tanda) y la firma de `listPaymentOrders`, que tiene
//     otros llamadores. Queda anotado en el reporte; mientras tanto el aviso
//     dice «puede haber más», no inventa un total.
//   · Conteos del Segmented sobre TODAS las órdenes ignorando búsqueda y chips:
//     «Pendientes 4» con la tabla mostrando 1 obliga a adivinar qué filtro
//     está escondiendo los otros 3. Cuentan sobre lo que dejan búsqueda+chips.
// ─────────────────────────────────────────────────────────────────────────────

import {
  TRANSITIONS,
  descripcionDeLineas,
  type PaymentMethod,
  type PaymentOrder,
  type PaymentOrderStatus,
} from '@/lib/payment-orders/types';

export type StatusFilter = 'all' | PaymentOrderStatus;

/** Todos los estados, en el orden de la máquina de estados (registro único). */
export const ORDER_STATUSES = Object.keys(TRANSITIONS) as PaymentOrderStatus[];

/** «Todas» + un filtro por estado. */
export const STATUS_FILTERS: readonly StatusFilter[] = ['all', ...ORDER_STATUSES];

/**
 * Cuántas órdenes pide el listado. Es el MAX_LIMIT de
 * api/admin/payment-orders/route.ts: si el servidor lo baja, el aviso de
 * recorte se dispara de más (nunca de menos), que es el lado seguro.
 */
export const LIST_LIMIT = 500;

/** ¿La lista vino llena? Entonces puede haber más órdenes que no llegaron. */
export function isListTruncated(received: number, requested: number = LIST_LIMIT): boolean {
  return received >= requested;
}

/** Moneda para sumar: USDT ≡ USD (el resto de la app lo trata 1:1). */
export function normCurrency(currency: string | null | undefined, fallback = 'USD'): string {
  const c = (currency || fallback).toUpperCase();
  return c === 'USDT' ? 'USD' : c;
}

/** Concepto de la orden para la meta de la fila: líneas, si no las notas. */
export function orderConcept(o: Pick<PaymentOrder, 'lines' | 'notes'>): string | null {
  return descripcionDeLineas(o.lines) ?? (o.notes?.trim() || null);
}

// ── Chips (beneficiario / medio) ────────────────────────────────────────────

export interface ChipFilters {
  methods: PaymentMethod[];
  /** Clave normalizada del beneficiario (ver beneficiaryKey). */
  beneficiaries: string[];
}

export const NO_CHIPS: ChipFilters = { methods: [], beneficiaries: [] };

/** Agrupa por id de libreta si lo hay; si no, por nombre sin mayúsculas. */
export function beneficiaryKey(o: Pick<PaymentOrder, 'beneficiary_id' | 'beneficiary_name'>): string {
  return o.beneficiary_id ? `id:${o.beneficiary_id}` : `name:${(o.beneficiary_name ?? '').trim().toLowerCase()}`;
}

export interface BeneficiaryChip {
  key: string;
  label: string;
  count: number;
}

/**
 * Los `max` beneficiarios con más órdenes (empate: alfabético) + cuántos
 * quedaron afuera — el recorte se cuenta en la UI («+12 más: usá el buscador»).
 */
export function beneficiaryChips(
  orders: PaymentOrder[],
  max = 5,
): { chips: BeneficiaryChip[]; hidden: number } {
  const by = new Map<string, BeneficiaryChip>();
  for (const o of orders) {
    const key = beneficiaryKey(o);
    const cur = by.get(key);
    if (cur) cur.count += 1;
    else by.set(key, { key, label: o.beneficiary_name?.trim() || '—', count: 1 });
  }
  const all = [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { chips: all.slice(0, max), hidden: Math.max(0, all.length - max) };
}

/** Conteo por medio de pago (para los chips «USDT» / «Banco»). */
export function methodCounts(orders: PaymentOrder[]): Record<PaymentMethod, number> {
  const out: Record<PaymentMethod, number> = { crypto: 0, bank: 0 };
  for (const o of orders) out[o.payment_method] = (out[o.payment_method] ?? 0) + 1;
  return out;
}

// ── Filtro ──────────────────────────────────────────────────────────────────

function matchesQuery(o: PaymentOrder, q: string): boolean {
  if (!q) return true;
  return (
    o.order_number.toLowerCase().includes(q) ||
    (o.beneficiary_name ?? '').toLowerCase().includes(q) ||
    (orderConcept(o) ?? '').toLowerCase().includes(q)
  );
}

function matchesChips(o: PaymentOrder, chips: ChipFilters): boolean {
  // Dentro de una dimensión, OR (USDT o Banco); entre dimensiones, AND.
  if (chips.methods.length > 0 && !chips.methods.includes(o.payment_method)) return false;
  if (chips.beneficiaries.length > 0 && !chips.beneficiaries.includes(beneficiaryKey(o))) return false;
  return true;
}

/** Lo que dejan búsqueda + chips, antes del estado (base de los conteos). */
export function applySearchAndChips(orders: PaymentOrder[], query: string, chips: ChipFilters): PaymentOrder[] {
  const q = query.trim().toLowerCase();
  return orders.filter((o) => matchesQuery(o, q) && matchesChips(o, chips));
}

/** Conteo por filtro de estado sobre una base ya filtrada por búsqueda+chips. */
export function statusCounts(orders: PaymentOrder[]): Record<StatusFilter, number> {
  const out = Object.fromEntries(STATUS_FILTERS.map((f) => [f, 0])) as Record<StatusFilter, number>;
  for (const o of orders) {
    out.all += 1;
    if (o.status in out) out[o.status] += 1;
  }
  return out;
}

/** Orden del listado: emisión más reciente primero; empate por número desc. */
export function sortOrders(orders: PaymentOrder[]): PaymentOrder[] {
  return [...orders].sort(
    (a, b) =>
      (b.issue_date ?? '').localeCompare(a.issue_date ?? '') || b.order_number.localeCompare(a.order_number),
  );
}

export function filterOrders(
  orders: PaymentOrder[],
  opts: { status: StatusFilter; query: string; chips: ChipFilters },
): PaymentOrder[] {
  const base = applySearchAndChips(orders, opts.query, opts.chips);
  return sortOrders(opts.status === 'all' ? base : base.filter((o) => o.status === opts.status));
}

// ── Sumas que respetan la moneda ────────────────────────────────────────────

export interface MoneySum {
  /** Órdenes del conjunto. */
  count: number;
  /** Suma de las que están en la moneda de la empresa. */
  sum: number;
  /** Cuántas quedaron fuera de la suma por estar en otra moneda. */
  otherCurrency: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function sumInCurrency(orders: PaymentOrder[], companyCurrency: string): MoneySum {
  const base = normCurrency(companyCurrency);
  let sum = 0;
  let otherCurrency = 0;
  for (const o of orders) {
    if (normCurrency(o.currency, base) !== base) {
      otherCurrency += 1;
      continue;
    }
    sum += Number(o.total) || 0;
  }
  return { count: orders.length, sum: round2(sum), otherCurrency };
}

/**
 * Valor a mostrar de una suma: si TODO el conjunto está en otra moneda, la
 * suma no es $0.00 — es «sin dato» (null → «—», reglas §1.3). Un conjunto
 * vacío sí es cero de verdad.
 */
export function sumOrNull(s: MoneySum): number | null {
  return s.count > 0 && s.otherCurrency === s.count ? null : s.sum;
}

// ── KPIs ────────────────────────────────────────────────────────────────────

/** «2026-10» del instante dado, en UTC. */
export function utcMonth(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/** Estados que NO cuentan como «emitido» del mes: no comprometen plata. */
export const NOT_COMMITTED: readonly PaymentOrderStatus[] = ['draft', 'rejected', 'cancelled'];

export interface OrderKpis {
  pending: MoneySum;
  approved: MoneySum;
  paidMonth: MoneySum;
  /** Emitidas este mes (issue_date) que comprometen plata: pendiente, aprobada o pagada. */
  monthTotal: MoneySum;
  /** Emitidas este mes que NO se sumaron por su estado (borrador/rechazada/anulada). */
  monthExcluded: number;
}

export function orderKpis(orders: PaymentOrder[], now: Date, companyCurrency: string): OrderKpis {
  const ym = utcMonth(now);
  const by = (s: PaymentOrderStatus) => orders.filter((o) => o.status === s);
  const paidThisMonth = orders.filter(
    (o) => o.status === 'paid' && (o.paid_at ?? o.payment_date ?? '').slice(0, 7) === ym,
  );
  const issuedThisMonth = orders.filter((o) => (o.issue_date ?? '').slice(0, 7) === ym);
  const committed = issuedThisMonth.filter((o) => !NOT_COMMITTED.includes(o.status));
  return {
    pending: sumInCurrency(by('pending'), companyCurrency),
    approved: sumInCurrency(by('approved'), companyCurrency),
    paidMonth: sumInCurrency(paidThisMonth, companyCurrency),
    monthTotal: sumInCurrency(committed, companyCurrency),
    monthExcluded: issuedThisMonth.length - committed.length,
  };
}
