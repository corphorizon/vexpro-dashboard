// ─────────────────────────────────────────────────────────────────────────────
// income-view — las decisiones de /ingresos que no son de dibujo, puras para
// testearlas sin DOM (mismo patrón que egresos/expenses-view.ts).
//
// POR QUÉ (2026-10-12, migración «Libro mayor»):
//   · Facturación por cliente: la pantalla no la tenía y el PDF de cierre de
//     una empresa de servicios sí (socios/page.tsx → buildBilling). Se arma
//     con `cardsFromLines` + `buildBilling`, las MISMAS funciones del PDF y de
//     /finanzas/reportes: «cobrado» tiene una sola fórmula. Acá no se suma
//     nada por cliente a mano.
//   · Estado de la línea: la página decidía «Cobrado / Por cobrar» con
//     `pending <= 0,009`. Una factura de $1.000 con $400 cobrados se veía
//     «Por cobrar» igual que una sin cobrar nada. Ahora hay «Parcial»; el
//     umbral del centavo es el mismo de antes (PENDING_EPSILON).
//
// DESCARTADO:
//   · Reusar el dominio `expense` de status-kind.ts (pagado/pendiente/parcial)
//     para las líneas: `expenseStatus` da «pendiente» a una línea de $0 con $0
//     cobrado, y la pantalla de ingresos siempre la mostró «Cobrado» (no se
//     debe nada). El mapa de color es local y chico, y es el único.
// ─────────────────────────────────────────────────────────────────────────────

import { cardsFromLines } from '@/lib/clients';
import { buildBilling, type BillingReport } from '@/lib/reports/company-report';
import type { IncomeLine } from '@/lib/income-lines';
import type { StatusKind } from '@/components/ui/status-kind';

/** Un pendiente por debajo del centavo es redondeo, no una deuda. */
export const PENDING_EPSILON = 0.009;

export type IncomeLineStatus = 'collected' | 'partial' | 'pending';

/** Color de cada estado (registro único para esta pantalla). */
export const INCOME_STATUS_KIND: Record<IncomeLineStatus, StatusKind> = {
  collected: 'ok',
  partial: 'pend', // falta cobrar una parte: sigue requiriendo acción
  pending: 'pend',
};

export function incomeLineStatus(l: Pick<IncomeLine, 'received' | 'pending'>): IncomeLineStatus {
  const pending = Number(l.pending) || 0;
  const received = Number(l.received) || 0;
  if (pending <= PENDING_EPSILON) return 'collected';
  if (received <= PENDING_EPSILON) return 'pending';
  return 'partial';
}

export type SortState = 'default' | 'desc' | 'asc';

/** Búsqueda por concepto, cliente o referencia + orden por monto (estable). */
export function filterIncomeLines(lines: IncomeLine[], query: string, sort: SortState): IncomeLine[] {
  const q = query.trim().toLowerCase();
  const out = q
    ? lines.filter(
        (l) =>
          l.concept.toLowerCase().includes(q) ||
          (l.client ?? '').toLowerCase().includes(q) ||
          (l.reference ?? '').toLowerCase().includes(q),
      )
    : [...lines];
  if (sort === 'desc') out.sort((a, b) => b.amount - a.amount);
  else if (sort === 'asc') out.sort((a, b) => a.amount - b.amount);
  return out;
}

export interface PeriodMeta {
  id: string;
  year: number;
  month: number;
  label: string;
}

/**
 * Facturación por cliente de las líneas dadas — buildBilling sobre
 * cardsFromLines, como el PDF de cierre. Las líneas de un período que no
 * está en `periods` no se descartan: entran con orden 0 (sólo afecta qué
 * grafía del nombre gana), porque sacarlas haría que el total por cliente no
 * cuadre con el de la tabla de líneas.
 */
export function billingByClient(lines: IncomeLine[], periods: PeriodMeta[]): BillingReport {
  const meta = new Map(periods.map((p) => [p.id, p]));
  return buildBilling(
    cardsFromLines(
      lines.map((l) => {
        const p = meta.get(l.period_id);
        return { ...l, periodLabel: p?.label ?? '—', periodOrder: p ? p.year * 12 + p.month : 0 };
      }),
    ),
  );
}
