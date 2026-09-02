// ─────────────────────────────────────────────────────────────────────────────
// Checklist de cierre de período — reglas PURAS.
//
// Qué hay acá y por qué (auditoría de finanzas, ítem 22):
//
//  a) El REGISTRO ÚNICO de los ítems del checklist. Las etiquetas estaban
//     hardcodeadas en castellano dentro de la API
//     (period-close-checklist/route.ts:129-172), así que la pantalla de cierre
//     era la única del dashboard que no hablaba inglés. Ahora cada ítem tiene
//     su clave de i18n y el texto vive donde vive el resto (§5, punto 7).
//
//  b) Los DOS CHEQUEOS NUEVOS que atrapan plata:
//     · Deriva contra `crm_monthly_totals`: lo cargado a mano contra lo que el
//       CRM ya sabe. Medido en producción el 2026-08-31 — Feb-26 tenía la
//       categoría `prop_firm` sin cargar y el CRM con $2.373,37. Los retiros
//       de prop firm RESTAN de la base distribuible: cerrar sin esa fila
//       repartió de más. Este aviso lo habría atrapado antes del cierre.
//     · Salto devengado/caja de los egresos: `close_period` congela
//       `total_expenses` como `sum(amount)` (DEVENGADO), pero en
//       `business_model = 'company'` la cadena de distribución usa `paid`
//       (CAJA, §2.2). Cerrar le cambia los egresos al tenant sin avisar.
//       Medido: Horizon, Ago-26, devengado 21.928,23 contra caja 16.563,23 →
//       −5.365,00.
//
//  c) El ORDEN CRONOLÓGICO: la cadena de distribución es SECUENCIAL (§2.2 —
//     hay que procesar todos los períodos en orden o el arrastre de
//     deuda/reserva diverge). Cerrar Ago antes que Jul congela un mes contra
//     un arrastre que todavía puede cambiar. Es el único ítem BLOQUEANTE del
//     checklist, y el bloqueo real está en la RPC `close_period` (migración
//     111): acá se explica antes de que la persona apriete el botón.
//
// Todo lo de este archivo es puro: recibe números y devuelve decisiones. Las
// consultas viven en la API, la traducción en la UI.
// ─────────────────────────────────────────────────────────────────────────────

import { features } from './business-model';

/**
 * `warning` = cerrar igual es legítimo (una orden aprobada que se paga el mes
 * que viene). `blocking` = no se puede cerrar, y la RPC lo rechaza aunque
 * alguien llame la API a mano.
 */
export type ChecklistSeverity = 'warning' | 'blocking';

export interface ChecklistItem {
  key: string;
  /** Clave de i18n. La UI traduce; la API NO arma texto de pantalla. */
  labelKey: string;
  count: number;
  /** Detalle ya formateado (nombres, importes). `null` si no aplica. */
  detail: string | null;
  severity: ChecklistSeverity;
  /**
   * Texto de respaldo en castellano. Existe SÓLO para que un cliente viejo en
   * caché —que todavía lee `label`— no muestre una clave cruda. La pantalla
   * nueva traduce por `labelKey`.
   */
  label?: string;
}

/**
 * Registro ÚNICO de los ítems. Agregar un chequeo es agregar una entrada acá
 * y su clave en i18n (en y es) — no una segunda lista en la API ni en la
 * pantalla. El test itera sobre este registro, así que un ítem sin clave de
 * i18n rompe el build en vez de mostrar la clave cruda en producción.
 */
export const CHECKLIST_LABEL_KEYS = {
  expenses_no_proof: 'periodClose.expensesNoProof',
  income_lines_uncollected: 'periodClose.incomeUncollected',
  liquidity_unreconciled: 'periodClose.liquidityUnreconciled',
  orders_approved_unpaid: 'periodClose.ordersUnpaid',
  investments_mixed: 'periodClose.investmentsMixed',
  crm_drift: 'periodClose.crmDrift',
  expenses_accrual_cash_gap: 'periodClose.accrualCashGap',
  earlier_periods_open: 'periodClose.earlierPeriodsOpen',
  fairpay_adjustment_missing: 'periodClose.fairpayAdjustmentMissing',
  fairpay_adjustment_no_data: 'periodClose.fairpayAdjustmentNoData',
} as const;

export type ChecklistKey = keyof typeof CHECKLIST_LABEL_KEYS;

// ─────────────────────────────────────────────────────────────────────────────
// b1) Deriva contra el CRM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Qué se compara y por qué SÓLO estas dos métricas.
 *
 * `crm_monthly_totals` tiene siete métricas, pero `ib_commissions` y
 * `p2p_transfers` no se cargan a mano a propósito (son informativas: no entran
 * ni al Net Deposit ni a la base distribuible). Incluirlas haría que TODOS los
 * meses aparecieran con deriva —medido el 2026-08-31: los 11 períodos de Vex
 * Pro tienen el manual en 0 y el CRM con seis cifras—, y un checklist que
 * siempre grita es un checklist que enseña a cerrar sin leer. Se comparan las
 * dos que mueven la plata que se reparte (§2.2).
 */
export const CRM_DRIFT_METRICS = [
  { key: 'propfirm_sales', crmMetric: 'propfirm_sales', labelKey: 'periodClose.metricPropFirmSales' },
  { key: 'propfirm_withdrawals', crmMetric: 'propfirm_withdrawals', labelKey: 'periodClose.metricPropFirmWithdrawals' },
] as const;

export interface CrmDriftInput {
  key: string;
  /** Lo cargado a mano en el dashboard. */
  manual: number;
  /** Lo que el CRM calculó para ese mes, o `null` si no lo tiene. */
  crm: number | null;
}

export interface CrmDriftRow extends CrmDriftInput {
  diff: number;
}

/**
 * Tolerancias. La absoluta evita el ruido de centavos; la relativa evita que
 * un mes grande dispare por un redondeo. Medido sobre los 11 períodos de Vex
 * Pro (2026-08-31): con estos umbrales quedan afuera Jul-26 (+68,80 sobre
 * 14.645 = 0,47%) y su −0,98 de retiros, y entran los que importan —Feb-26
 * −2.373,37, Oct-25 −8.440,00, Ago-26 −11.981,70.
 */
export const CRM_DRIFT_ABS = 1;
export const CRM_DRIFT_REL = 0.005;

/**
 * Deriva entre lo cargado a mano y lo que el CRM ya sabe.
 *
 * `crm: null` NO es deriva: es "el CRM no tiene ese mes". `null` y `0` no son
 * lo mismo (§1.3) — afirmar que el CRM dice cero cuando no dijo nada es
 * inventar un desvío.
 */
export function computeCrmDrift(rows: CrmDriftInput[]): CrmDriftRow[] {
  const out: CrmDriftRow[] = [];
  for (const row of rows) {
    if (row.crm === null || !Number.isFinite(row.crm)) continue;
    const diff = row.manual - row.crm;
    const scale = Math.max(Math.abs(row.crm), Math.abs(row.manual));
    if (Math.abs(diff) < CRM_DRIFT_ABS) continue;
    if (scale > 0 && Math.abs(diff) / scale < CRM_DRIFT_REL) continue;
    out.push({ ...row, diff });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// b2) Salto devengado / caja en los egresos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cuánto le cambiarían los egresos al tenant por cerrar el mes.
 *
 * Sólo aplica a los modelos con `cashBasisExpenses` (hoy: 'company'): son los
 * únicos donde la cadena usa la base CAJA (`paid`) mientras el snapshot de
 * cierre congela el DEVENGADO (`sum(amount)`). Donde las dos son devengado no
 * hay salto. Devuelve `null` cuando el chequeo no corresponde — que no es lo
 * mismo que 0.
 */
export function computeAccrualCashGap(params: {
  businessModel: string | null | undefined;
  totalAccrued: number;
  totalPaid: number;
}): number | null {
  // Mismo criterio que buildDistributionInputs: lo decide el registro, no una
  // comparación contra el literal 'company'. Un modelo nuevo que sí usara caja
  // habría quedado sin este chequeo y sin que nada avise.
  if (!features(params.businessModel).cashBasisExpenses) return null;
  const gap = params.totalPaid - params.totalAccrued;
  return Math.abs(gap) < 0.005 ? 0 : gap;
}

// ─────────────────────────────────────────────────────────────────────────────
// b3) El egreso «Ajuste FairPay» del mes
//
// FairPay cobra al cliente un recargo de ~4% que nunca se le acredita en la
// billetera. Es un costo real del canal y Kevin decidió (2026-08-31)
// contabilizarlo como un EGRESO manual, uno por mes. El cálculo lo deja el
// sync en `crm_monthly_totals` como la métrica `fairpay_adjustment` (el porqué
// del cruce está en `crm-monthly.ts`); acá sólo se pregunta si el egreso está.
//
// El primer egreso, cargado en Ago-26 por $2.994,83, cubre el histórico
// abr→ago 2026 completo. Por eso Ago-26 tiene que dar CUBIERTO: la fila
// existe. De septiembre en adelante, cada mes necesita el suyo.
//
// Las tres reglas que hacen que esto no falle en silencio:
//   1. Un mes SIN pagos de FairPay no genera ítem. Sin esto, las empresas que
//      no usan el canal (AP Markets, Horizon) y los meses anteriores a abril
//      de 2026 gritarían para siempre — y un checklist que siempre grita
//      enseña a cerrar sin leer.
//   2. Un mes CON pagos pero SIN métrica no pasa en silencio ni se asume $0:
//      dice «sin dato del CRM». Es la señal de que el sync no corrió o falló,
//      y es información distinta de «no hay recargo» (§1.3).
//   3. El ajuste en 0 (o negativo) NO pide egreso: se miró y no hay nada que
//      cargar. Se informa igual, con su cifra, para que el cero sea VISIBLE.
// ─────────────────────────────────────────────────────────────────────────────

/** La métrica de `crm_monthly_totals` que trae el ajuste ya calculado. */
export const FAIRPAY_ADJUSTMENT_METRIC = 'fairpay_adjustment';

/**
 * Con qué se reconoce el egreso del mes. Es un `ILIKE 'Ajuste FairPay%'`: el
 * egreso real que Kevin cargó se llama «Ajuste FairPay (recargo cobrado no
 * acreditado, histórico abr→ago 2026)», así que anclar el texto completo no
 * serviría para ningún mes siguiente.
 */
export const FAIRPAY_EXPENSE_PREFIX = 'Ajuste FairPay';

/** Debajo de un centavo no hay egreso que cargar. */
export const FAIRPAY_ADJUSTMENT_MIN = 0.005;

export type FairpayCheck =
  /** El mes no tuvo pagos de FairPay: el chequeo no corresponde. */
  | { state: 'not_applicable' }
  /** Hubo pagos pero el CRM no calculó la métrica: no se inventa un $0. */
  | { state: 'no_data' }
  /** Se calculó y da (prácticamente) cero: no hay nada que cargar. */
  | { state: 'nothing_to_load'; amount: number }
  /** Hay ajuste y el egreso está cargado. */
  | { state: 'covered'; amount: number }
  /** Hay ajuste y falta el egreso. Esto es lo que atrapa plata. */
  | { state: 'missing'; amount: number };

/**
 * ¿Le falta a este mes el egreso «Ajuste FairPay»?
 *
 * `crmAdjustment === null` significa «el CRM no tiene la métrica de este mes»,
 * que NO es cero (§1.3): afirmar que el recargo fue $0 cuando nadie lo calculó
 * es exactamente el número plausible y equivocado que este repo persigue.
 */
export function checkFairpayAdjustment(params: {
  /** Pagos de FairPay `Completed` del mes calendario. 0 → no corresponde. */
  fairpayPaymentsInMonth: number;
  /** `crm_monthly_totals.amount` de `fairpay_adjustment`, o `null` si no hay fila. */
  crmAdjustment: number | null;
  /** ¿Hay un egreso del período con concepto `Ajuste FairPay…`? */
  expenseLoaded: boolean;
}): FairpayCheck {
  if (!(params.fairpayPaymentsInMonth > 0)) return { state: 'not_applicable' };
  if (params.crmAdjustment === null || !Number.isFinite(params.crmAdjustment)) {
    return { state: 'no_data' };
  }
  if (params.crmAdjustment <= FAIRPAY_ADJUSTMENT_MIN) {
    return { state: 'nothing_to_load', amount: params.crmAdjustment };
  }
  return params.expenseLoaded
    ? { state: 'covered', amount: params.crmAdjustment }
    : { state: 'missing', amount: params.crmAdjustment };
}

// ─────────────────────────────────────────────────────────────────────────────
// c) Orden cronológico
// ─────────────────────────────────────────────────────────────────────────────

export interface PeriodOrderRow {
  id: string;
  year: number;
  month: number;
  label: string | null;
  isClosed: boolean;
}

/**
 * Períodos ANTERIORES al que se quiere cerrar que siguen abiertos.
 *
 * La cadena de distribución es secuencial: el saldo a favor y la reserva de un
 * mes son el punto de partida del siguiente. Cerrar Ago con Jul abierto
 * congela los insumos de agosto contra un arrastre que todavía puede cambiar
 * — y como se congelan INSUMOS y no resultados (§2.3), el número congelado se
 * recalcula solo cuando julio se mueva. Verificado en producción el
 * 2026-08-31: los 9 períodos cerrados de Vex Pro son contiguos, así que exigir
 * el orden no rompe ningún cierre existente.
 */
export function earlierOpenPeriods(
  periods: PeriodOrderRow[],
  target: { year: number; month: number },
): PeriodOrderRow[] {
  const targetKey = target.year * 100 + target.month;
  return periods
    .filter((p) => !p.isClosed && p.year * 100 + p.month < targetKey)
    .sort((a, b) => a.year * 100 + a.month - (b.year * 100 + b.month));
}
