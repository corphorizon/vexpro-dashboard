// ─────────────────────────────────────────────────────────────────────────────
// /finanzas/forecast — lo que la pantalla decide sobre los compromisos
// firmados (órdenes aprobadas sin pagar), fuera del JSX para fijarlo con test.
//
// ── EL BUG (2026-10-12, migración «Libro mayor») ───────────────────────────
// La lectura de /api/admin/payment-orders?status=approved terminaba en
//     .catch(() => { /* el forecast funciona igual sin este dato */ });
// con el estado arrancando en `[]`: si el endpoint fallaba (o respondía
// `success: false`), el KPI «Compromisos firmados» decía «$0.00 · 0 órdenes»
// — que se lee como «no hay nada aprobado por pagar», una afirmación sobre la
// plata. La proyección sí funciona igual (no usa este dato); el KPI no.
// Ahora: `null` mientras carga o si falló → «—» con el motivo.
//
// Y el recorte: el endpoint devuelve como mucho `limit` órdenes. Antes la
// pantalla no pasaba `limit` (el servidor usa 200 por defecto) y sumaba lo que
// llegaba sin mirar si estaba recortado. Ahora el límite lo pide la pantalla
// (el mismo 200: el total no cambia) y, si vuelven exactamente 200, el KPI
// dice que puede haber más: un recorte silencioso es indistinguible de «no
// hay más» (reglas-del-proyecto.md §1.2).
//
// DESCARTADO: pedir 500 (el máximo del endpoint) — cambiaría el total en las
// empresas con más de 200 órdenes aprobadas sin que nadie lo decida, y seguiría
// pudiendo recortar.
// ─────────────────────────────────────────────────────────────────────────────

/** Límite que esta pantalla le pide al endpoint de órdenes (= su default). */
export const COMMITTED_ORDERS_LIMIT = 200;

export interface ApprovedOrder {
  id: string;
  order_number: string;
  beneficiary_name: string;
  total: number;
}

export type CommittedState =
  | { status: 'loading' }
  | { status: 'ok'; orders: ApprovedOrder[] }
  | { status: 'failed' };

export interface CommittedSummary {
  /** Suma de las órdenes recibidas. null = no lo sabemos (cargando / falló). */
  total: number | null;
  count: number | null;
  /** Vino el límite exacto: puede haber más órdenes que las sumadas. */
  truncated: boolean;
}

export function committedSummary(state: CommittedState, limit = COMMITTED_ORDERS_LIMIT): CommittedSummary {
  if (state.status !== 'ok') return { total: null, count: null, truncated: false };
  const total = state.orders.reduce((s, o) => s + o.total, 0);
  return { total, count: state.orders.length, truncated: state.orders.length >= limit };
}

/**
 * Deuda que arrastra el último mes proyectado, con signo de pasivo (≤ 0),
 * igual que la columna de la tabla. `null` si no hay meses proyectados: sin
 * proyección no hay deuda que afirmar, ni siquiera cero.
 */
export function lastCarriedDebt(months: ReadonlyArray<{ debtOut: number }>): number | null {
  const last = months.at(-1);
  if (!last) return null;
  return last.debtOut > 0 ? -last.debtOut : 0;
}
