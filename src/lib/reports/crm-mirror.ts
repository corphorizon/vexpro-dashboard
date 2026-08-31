// ─────────────────────────────────────────────────────────────────────────────
// Usuarios CRM y Prop Trading del informe, leídos del ESPEJO.
//
// POR QUÉ EXISTE (2026-08-31, auditoría de finanzas)
// Las dos secciones salían de endpoints REST de Orion —`/v1/users/summary` y
// `/v1/prop-trading`— que en producción NO EXISTEN para ningún inquilino:
// `api_credentials` no tiene una sola fila `provider='orion_crm'`. Sin
// credencial, los fetchers caen a su generador de datos falsos (o a ceros), así
// que el informe diario salía con «Usuarios CRM» y «Prop Trading Firm»
// inventados o vacíos, con el mismo título con el que saldrían si fueran
// reales. Es el mismo trabajo que ya se hizo con Broker P&L el mismo día
// («debemos tomar el dato que da el crm»): la fuente correcta es el espejo que
// el sync del CRM ya viene llenando.
//
//   · Usuarios      → `crm_user_snapshots.register_date`
//     Medido el 2026-08-31 sobre Vex Pro: día 180 · semana 812 · mes 2.519 ·
//     total 21.680. El endpoint REST devolvía ceros.
//   · Prop trading  → `crm_monthly_totals`, métricas `propfirm_sales` y
//     `propfirm_withdrawals` (migración 100). Agosto 2026: ventas $11.981,70 ·
//     retiros $2.819,04.
//
// LO QUE EL ESPEJO NO PUEDE RESPONDER, Y NO SE INVENTA
//
// 1. EL DESGLOSE POR PRODUCTO. `crm_monthly_totals` guarda el total del mes,
//    no qué se vendió. La tabla «Productos vendidos» no se puede llenar con lo
//    guardado, así que devuelve `null` —«sin desglose disponible»— en vez de
//    una lista vacía que se lee como «no se vendió nada». `null` y `0` no son
//    lo mismo (§1.3 de docs/reglas-del-proyecto.md).
//
// 2. UN RANGO QUE NO SON MESES ENTEROS. El espejo es MENSUAL. Para el informe
//    diario, «las ventas del 15 de agosto» no existen en esta tabla y repartir
//    el mes entre sus días sería fabricar un número. Cuando el rango no empieza
//    el día 1 y termina el último día de un mes, los campos del rango vuelven
//    `null` y la pantalla dice «sin datos». Los del MES sí se responden
//    siempre, porque el mes es justamente la grilla de la tabla.
//
// SERVER-ONLY: recibe el admin client ya creado, como el resto de reports/.
// ─────────────────────────────────────────────────────────────────────────────

import type { createAdminClient } from '@/lib/supabase/admin';

type Admin = ReturnType<typeof createAdminClient>;

export interface CrmUsersFromMirror {
  new_users_in_range: number;
  new_users_this_month: number;
  total_users: number;
  connected: boolean;
  isMock: boolean;
}

/**
 * Conteos de altas desde el espejo de usuarios.
 *
 * `connected: false` cuando el espejo está VACÍO para la empresa: un inquilino
 * sin sync de CRM no tiene esta sección, y mostrarle tres ceros sería decirle
 * que no se registró nadie. Cero usuarios en total y cero altas se ven igual;
 * la diferencia la hace este flag.
 */
export async function loadCrmUsersFromMirror(
  admin: Admin,
  companyId: string,
  from: string,
  to: string,
  monthFrom: string,
  monthTo: string,
): Promise<CrmUsersFromMirror> {
  const countBetween = async (a: string | null, b: string | null): Promise<number> => {
    let q = admin
      .from('crm_user_snapshots')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId);
    // El rango llega como YYYY-MM-DD y la columna es timestamptz: el día `to`
    // se incluye ENTERO (`< to+1día`). Con `lte(to)` se perdían las altas
    // posteriores a las 00:00:00 del último día, que son casi todas.
    if (a) q = q.gte('register_date', `${a}T00:00:00Z`);
    if (b) q = q.lt('register_date', `${nextDay(b)}T00:00:00Z`);
    const { count } = await q;
    return count ?? 0;
  };

  const [inRange, inMonth, total] = await Promise.all([
    countBetween(from, to),
    countBetween(monthFrom, monthTo),
    countBetween(null, null),
  ]);

  return {
    new_users_in_range: inRange,
    new_users_this_month: inMonth,
    total_users: total,
    connected: total > 0,
    isMock: false,
  };
}

export interface PropTradingFromMirror {
  /** `null` = el espejo no guarda el desglose. NUNCA una lista vacía. */
  products: null;
  /** `null` = el rango no son meses enteros y el espejo es mensual. */
  total_sales_range: number | null;
  total_sales_month: number | null;
  prop_withdrawals_range: number | null;
  prop_withdrawals_count_range: number | null;
  pnl_range: number | null;
  pnl_month: number | null;
  pnl_prev_month: number | null;
  connected: boolean;
  isMock: boolean;
}

interface MonthlyRow {
  year: number;
  month: number;
  metric: string;
  amount: number | string | null;
  tx_count: number | null;
}

/** ¿[from, to] cubre meses calendario COMPLETOS? */
export function coversWholeMonths(from: string, to: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return false;
  if (!from.endsWith('-01')) return false;
  return to === lastDayOfMonth(to);
}

export async function loadPropTradingFromMirror(
  admin: Admin,
  companyId: string,
  from: string,
  to: string,
  month: { year: number; month: number },
  prevMonth: { year: number; month: number },
): Promise<PropTradingFromMirror> {
  const { data, error } = await admin
    .from('crm_monthly_totals')
    .select('year, month, metric, amount, tx_count')
    .eq('company_id', companyId)
    .in('metric', ['propfirm_sales', 'propfirm_withdrawals']);

  const rows = (error ? [] : ((data ?? []) as MonthlyRow[]));

  // `amount` es NULL cuando el mes no se pudo calcular (migración 100), y eso
  // NO es cero: se propaga como null hasta la pantalla.
  const pick = (y: number, m: number, metric: string): { amount: number | null; count: number } => {
    const r = rows.find((x) => x.year === y && x.month === m && x.metric === metric);
    if (!r) return { amount: null, count: 0 };
    const amount = r.amount === null || r.amount === undefined ? null : Number(r.amount);
    return {
      amount: amount !== null && Number.isFinite(amount) ? amount : null,
      count: Number(r.tx_count) || 0,
    };
  };

  const sumMonths = (
    months: Array<{ year: number; month: number }>,
    metric: string,
  ): { amount: number | null; count: number } => {
    let amount: number | null = null;
    let count = 0;
    for (const m of months) {
      const v = pick(m.year, m.month, metric);
      if (v.amount === null) continue;
      amount = (amount ?? 0) + v.amount;
      count += v.count;
    }
    return { amount, count };
  };

  const monthSales = pick(month.year, month.month, 'propfirm_sales');
  const monthWdr = pick(month.year, month.month, 'propfirm_withdrawals');
  const prevSales = pick(prevMonth.year, prevMonth.month, 'propfirm_sales');
  const prevWdr = pick(prevMonth.year, prevMonth.month, 'propfirm_withdrawals');

  // El rango solo se puede responder si son meses enteros — ver cabecera.
  const rangeMonths = coversWholeMonths(from, to) ? monthsBetween(from, to) : null;
  const rangeSales = rangeMonths ? sumMonths(rangeMonths, 'propfirm_sales') : null;
  const rangeWdr = rangeMonths ? sumMonths(rangeMonths, 'propfirm_withdrawals') : null;

  const minus = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : a - b;

  return {
    products: null,
    total_sales_range: rangeSales?.amount ?? null,
    total_sales_month: monthSales.amount,
    prop_withdrawals_range: rangeWdr?.amount ?? null,
    prop_withdrawals_count_range: rangeWdr ? rangeWdr.count : null,
    pnl_range: minus(rangeSales?.amount ?? null, rangeWdr?.amount ?? null),
    pnl_month: minus(monthSales.amount, monthWdr.amount),
    pnl_prev_month: minus(prevSales.amount, prevWdr.amount),
    // Hay espejo si la tabla tiene alguna fila de estas métricas para la
    // empresa. Sin filas, la sección dice «no conectado» en vez de $0,00.
    connected: rows.length > 0,
    isMock: false,
  };
}

// ── Fechas (UTC, sin depender de la zona del proceso) ────────────────────────

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function lastDayOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

/** Meses calendario que toca [from, to]. Solo se usa con meses enteros. */
export function monthsBetween(
  from: string,
  to: string,
): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  let y = fy;
  let m = fm;
  // Cota dura: un rango absurdo no puede colgar el informe.
  for (let i = 0; i < 240 && (y < ty || (y === ty && m <= tm)); i += 1) {
    out.push({ year: y, month: m });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
