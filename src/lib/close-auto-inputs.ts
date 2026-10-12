// ─────────────────────────────────────────────────────────────────────────────
// Cierre de período — qué se CONGELA de las series automáticas del CRM.
//
// POR QUÉ (incidente 2026-10-12): Kevin cerró Ago-26 y Sep-26 de Vex Pro a las
// 12:41 UTC y /socios cambió de golpe. La RPC `close_period` (migración 061)
// arma el snapshot leyendo SÓLO las tablas de carga manual:
// `operating_income.broker_pnl` y `prop_firm_sales` / `withdrawals`. Pero
// desde el 2026-08-31 el Broker P&L y la Prop Firm de un período abierto salen
// del CRM (broker-pnl.ts, regla 2: «un mes que se cierre mañana se congela con
// lo que la serie diga ese día»). Esa regla estaba escrita y no implementada:
// el cierre congelaba el manual viejo.
//
// Medido en prod el 2026-10-12:
//   · Ago-26: congeló Broker P&L $671.000 (el manual que broker-pnl.ts ya
//     marcaba como equivocado) contra $304.392,24 del CRM; Prop Firm 0 contra
//     $9.206,97 netos.
//   · Sep-26: congeló Broker P&L 0 y Prop Firm 0 (no había manual) contra
//     $226.899,80 y $13.248,27 → resultado negativo, nada para repartir.
//
// Acá se decide, con las MISMAS reglas que usa la pantalla del período
// abierto, qué valores automáticos manda el servidor a `close_period`
// (migración 131, parámetro `p_overrides`). Así lo congelado es exactamente lo
// que se veía un segundo antes de cerrar.
//
// REGLAS (las de la cadena para un período abierto, no otras):
//   · Broker P&L: `resolveBrokerPnl` del período abierto. Si da `crm`, se
//     congela ese valor. Si da `none` (sin serie) o `frozen` (anterior al
//     corte de ago-26), NO se manda override y la RPC congela el manual —
//     lo mismo que `brokerPnlForChain` mostraba.
//   · Prop Firm: `propFirmAutoForMonth`. Si ninguna de las dos métricas tiene
//     dato, no hay override (manda la carga manual); si al menos una lo tiene,
//     la que falte vale 0 — idéntico a lo que hacía la cadena.
//
// DESCARTADO:
//   · Escribir el valor del CRM en `operating_income` antes de cerrar: pisaría
//     lo tecleado sin dejar rastro de qué era manual y qué automático.
//   · Que el navegador mande los valores: un número que manda el cliente no
//     es evidencia (mismo criterio que el checklist de cierre).
// ─────────────────────────────────────────────────────────────────────────────

import {
  indexBrokerPnlMonths,
  monthlyBrokerPnl,
  resolveBrokerPnl,
  type BrokerPnlDailyLike,
} from './broker-pnl';

/** Lo mínimo de una fila mensual del CRM. `auto: null` = sin dato (≠ 0). */
export interface CrmMonthlyAutoLike {
  year: number;
  month: number;
  metric: string;
  auto: number | null;
}

/**
 * Prop Firm automática de un mes. `null` = el CRM no tiene ninguna de las dos
 * métricas para ese mes (manda la carga manual). Fuente única: la usan la
 * cadena del data-context y el cierre.
 */
export function propFirmAutoForMonth(
  rows: readonly CrmMonthlyAutoLike[],
  year: number,
  month: number,
): { sales: number; withdrawals: number } | null {
  const ventas = rows.find((r) => r.metric === 'propfirm_sales' && r.year === year && r.month === month);
  const retiros = rows.find((r) => r.metric === 'propfirm_withdrawals' && r.year === year && r.month === month);
  if (ventas?.auto == null && retiros?.auto == null) return null;
  return { sales: Number(ventas?.auto ?? 0), withdrawals: Number(retiros?.auto ?? 0) };
}

/** Lo que el servidor manda a `close_period(p_overrides)`. */
export interface ClosingOverrides {
  broker_pnl?: number;
  prop_firm_sales?: number;
  prop_firm_withdrawals?: number;
  /** Qué campos salieron del CRM. Queda en el snapshot como `auto_sources`. */
  auto_sources: string[];
}

export function closingOverrides(args: {
  year: number;
  month: number;
  dailyPnl: readonly BrokerPnlDailyLike[];
  crmMonthly: readonly CrmMonthlyAutoLike[];
}): ClosingOverrides {
  const out: ClosingOverrides = { auto_sources: [] };
  const index = indexBrokerPnlMonths(monthlyBrokerPnl(args.dailyPnl));
  // El período se evalúa ABIERTO: es lo que la pantalla mostraba antes de cerrar.
  const broker = resolveBrokerPnl({ year: args.year, month: args.month, is_closed: false }, index, null);
  if (broker.source === 'crm' && broker.value !== null) {
    out.broker_pnl = broker.value;
    out.auto_sources.push('broker_pnl');
  }
  const pf = propFirmAutoForMonth(args.crmMonthly, args.year, args.month);
  if (pf) {
    out.prop_firm_sales = pf.sales;
    out.prop_firm_withdrawals = pf.withdrawals;
    out.auto_sources.push('prop_firm_sales', 'prop_firm_withdrawals');
  }
  return out;
}
