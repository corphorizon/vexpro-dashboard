// ─────────────────────────────────────────────────────────────────────────────
// queue-view — las decisiones de la cola de retiros que no son de dibujo,
// puras para testearlas sin DOM («Libro mayor», 2026-10-12).
//
// QUÉ RESUELVE:
//   · Secciones: «Pendientes» y «Escalados» PARTEN la lista de solicitados
//     (status_raw = REQUESTED, ver QueueResult en withdrawal-risk/query.ts):
//     escalado = la última decisión registrada acá es `escalate` (soporte lo
//     subió y espera a finanzas). Los dos conteos suman exactamente los
//     solicitados — un retiro no puede quedar en las dos ni en ninguna.
//     Instantáneos e Historial siguen siendo las listas que manda el server.
//   · Chips por método: se arman con los métodos QUE HAY en la sección, con
//     su conteo. Una lista fija escondería un método nuevo con sus retiros.
//   · Totales: el monto `null` NO es 0 (reglas §1.3). Antes la pantalla hacía
//     `requested_amount ?? 0`: un retiro sin monto restaba en silencio del
//     «Esperando decisión». Ahora la suma es de los montos conocidos y
//     `missing` cuenta los que faltan, para que el KPI lo diga.
//   · Antigüedad: ≥ 7 días es «parado» (el corte que ya usaba la pantalla).
//     `ageDays` null no es «0 días»: no se marca ni se cuenta como parado.
//
// DESCARTADO:
//   · Filtrar la banda acá: la banda va al SERVIDOR (api.ts, el histórico son
//     decenas de miles de filas y el score se calcula por fila). Los chips de
//     banda sólo cambian el parámetro; sus conteos son los del server.
//   · Mezclar Escalados con Historial: un escalado sigue REQUESTED en el CRM
//     y sigue esperando una decisión — es trabajo, no lectura.
// ─────────────────────────────────────────────────────────────────────────────

import type { QueueItem } from '@/lib/withdrawal-risk/api';

/** Días desde los que un pedido se considera parado. */
export const STALE_DAYS = 7;

export type QueueSection = 'pending' | 'escalated';

export function queueSection(item: Pick<QueueItem, 'review'>): QueueSection {
  return item.review?.decision === 'escalate' ? 'escalated' : 'pending';
}

export function sectionCounts(items: Pick<QueueItem, 'review'>[]): Record<QueueSection, number> {
  const out: Record<QueueSection, number> = { pending: 0, escalated: 0 };
  for (const i of items) out[queueSection(i)] += 1;
  return out;
}

export interface MethodCount {
  method: string;
  count: number;
}

/** Métodos presentes, de más a menos frecuente (desempate alfabético, «—» último). */
export function methodCounts(items: Pick<QueueItem, 'paymentMethod'>[]): MethodCount[] {
  const n = new Map<string, number>();
  for (const i of items) {
    const k = i.paymentMethod || '—';
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n.entries()]
    .map(([method, count]) => ({ method, count }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        // «—» (sin método) al final de su empate: es la falta de dato.
        Number(a.method === '—') - Number(b.method === '—') ||
        a.method.localeCompare(b.method),
    );
}

export interface QueueRowFilter {
  section: QueueSection | null;
  /** null = todos los métodos. */
  method: string | null;
}

export function filterQueueRows<T extends Pick<QueueItem, 'review' | 'paymentMethod'>>(
  items: T[],
  f: QueueRowFilter,
): T[] {
  return items.filter(
    (i) =>
      (f.section === null || queueSection(i) === f.section) &&
      (f.method === null || (i.paymentMethod || '—') === f.method),
  );
}

export interface AmountTotal {
  /** Suma de los montos conocidos; null si no hay ninguno. */
  sum: number | null;
  count: number;
  /** Filas sin monto (null/NaN): NO sumadas, avisadas. */
  missing: number;
}

export function sumAmounts<T>(rows: T[], amount: (r: T) => number | null | undefined): AmountTotal {
  let sum = 0;
  let known = 0;
  let missing = 0;
  for (const r of rows) {
    const v = amount(r);
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      known += 1;
    } else missing += 1;
  }
  return { sum: known === 0 ? null : Math.round(sum * 100) / 100, count: rows.length, missing };
}

export function isStale(ageDays: number | null | undefined): boolean {
  return typeof ageDays === 'number' && Number.isFinite(ageDays) && ageDays >= STALE_DAYS;
}

export interface QueueKpis {
  total: AmountTotal;
  high: AmountTotal;
  stale: AmountTotal;
}

const amountOf = (i: Pick<QueueItem, 'withdrawal'>) => i.withdrawal.requested_amount;

export function queueKpis(items: Pick<QueueItem, 'withdrawal' | 'score' | 'ageDays'>[]): QueueKpis {
  return {
    total: sumAmounts(items, amountOf),
    high: sumAmounts(
      items.filter((i) => i.score.band === 'high'),
      amountOf,
    ),
    stale: sumAmounts(
      items.filter((i) => isStale(i.ageDays)),
      amountOf,
    ),
  };
}

/** USDT se muestra como USD (es lo que hacía la pantalla); sin moneda, la de la empresa. */
export function displayCurrency(coin: string | null | undefined, fallback: string | null | undefined): string {
  if (coin === 'USDT') return 'USD';
  return coin || fallback || 'USD';
}

// ── Dashboard de riesgo ─────────────────────────────────────────────────────

const BAND_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Los N retiros que más piden atención, para el panel del dashboard: banda
 * alta primero, después los que llevan más días (sin antigüedad conocida al
 * final de su banda — no se inventa que es nuevo ni viejo). La cola completa
 * sigue en /risk/retiros con su orden de bandeja de entrada; esto es sólo el
 * resumen de arriba. No muta la lista recibida.
 */
export function urgentQueue<T extends Pick<QueueItem, 'score' | 'ageDays'>>(items: T[], n = 5): T[] {
  const age = (d: number | null) => (typeof d === 'number' && Number.isFinite(d) ? d : -1);
  return [...items]
    .sort(
      (a, b) =>
        (BAND_ORDER[a.score.band] ?? 3) - (BAND_ORDER[b.score.band] ?? 3) || age(b.ageDays) - age(a.ageDays),
    )
    .slice(0, Math.max(0, n));
}

// ── Ficha (/risk/retiros/[id]) ───────────────────────────────────────────────

export type DetailDecision = 'approve' | 'reject' | 'escalate';

/**
 * El ÚNICO botón primario de la ficha (spec §5.1: uno por pantalla), según lo
 * que el rol PUEDE hacer — el mismo par de permisos que ya decidía qué botón
 * se habilita (roleCanApproveWithdrawal / roleCanTriageWithdrawal):
 *   · finanzas decide → «Aprobar» es la acción principal; rechazar va como
 *     peligro y escalar como secundaria;
 *   · soporte sólo triajea → su acción principal es «Escalar»;
 *   · sin permisos → ninguno (todos deshabilitados con el motivo).
 * No depende del score a propósito: si el primario cambiara con la banda, la
 * pantalla estaría sugiriendo la decisión (la cabecera de la cola lo prohíbe).
 */
export function primaryDecision(canApprove: boolean, canTriage: boolean): DetailDecision | null {
  if (canApprove) return 'approve';
  if (canTriage) return 'escalate';
  return null;
}

export interface FactorTally {
  down: number;
  up: number;
  neutral: number;
}

/** Cuántos factores empujan a cada lado — el resumen sobre la lista de señales. */
export function factorTally(factors: { impact: 'up' | 'down' | 'neutral' }[]): FactorTally {
  const out: FactorTally = { down: 0, up: 0, neutral: 0 };
  for (const f of factors) out[f.impact] += 1;
  return out;
}
