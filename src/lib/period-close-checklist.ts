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
//     · Comisiones sin guardar (2026-10-18): septiembre-2026 de Vex Pro se
//       cerró con 11 grupos de /comisiones con líneas sin fila en
//       `commercial_monthly_results`. Mes cerrado = manda lo guardado
//       (hr/net-deposit-input.ts), así que el hueco quedó congelado sin un
//       solo error. Ver la sección b4.
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
import { estaActivo, estaDespedido } from './hr/domain';

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
  commissions_unsaved: 'periodClose.commissionsUnsaved',
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
// b4) Comisiones sin guardar
//
// ── El incidente (medido el 2026-10-18) ────────────────────────────────────
// Septiembre-2026 de Vex Pro se CERRÓ con 11 grupos de /comisiones que tenían
// líneas sin fila en `commercial_monthly_results`. El grupo de Luis Diaz cerró
// sin la fila del propio head —la pantalla congelada muestra «sin datos» y
// comisión $0—; el de Nicolas Skwarok, con 7 líneas sin guardar. Mes cerrado =
// manda lo guardado (semántica DELIBERADA de hr/net-deposit-input.ts), así que
// cerrar con huecos congela el hueco en silencio: el fallo-sin-error del §1.2.
//
// ── La regla ───────────────────────────────────────────────────────────────
// Un GRUPO es un perfil con al menos un miembro visible colgando
// (`head_id` = su id). Sus LÍNEAS son el líder más esos miembros. Una línea
// está GUARDADA si existe una fila del período con `profile_id` = la línea y
// un `head_id` aceptado (ver `headIdsAceptados`). Sólo se mira la EXISTENCIA.
//
// ── Lo que se descartó ─────────────────────────────────────────────────────
//   · Mirar `net_deposit_current`: su semántica difiere entre la línea del
//     head (total de la estructura) y la de un miembro, y la fila propia del
//     head histórico puede traer su ND en `net_deposit_accumulated`. Pedir un
//     valor ≠ 0 daría falsos positivos; además un ND en 0 legítimo existe
//     (§2.1 regla 2). Un 0 guardado es un dato; la fila que falta, no.
//   · Llamar `hr_net_deposit_by_profile` / `hr_padres_resueltos` para armar
//     la estructura «como la ve el CRM»: el checklist corre DENTRO del request
//     de cierre y esas RPC pueden pasar el statement timeout. Alcanza con
//     `commercial_profiles` + `commercial_monthly_results`, dos selects chicos.
//   · Contar a todos los que tienen `head_id` = líder, sin filtro de estado:
//     /comisiones (tab Equipos, `teamProfiles`) arma el grupo con
//     `appearsInCommissions` = activo o despedido. Un inactivo SIN fecha de
//     baja (licencia) no aparece en la pantalla, así que nadie puede guardarle
//     una fila: contarlo sería un falso positivo permanente. Se usan los
//     predicados del registro único de RRHH (hr/domain.ts), no una copia.
//   · Bloquear el cierre: el checklist avisa, la persona decide (puede haber
//     un grupo que legítimamente no cobra ese mes). Mismo trato que el resto.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo mínimo de `commercial_profiles` para armar los grupos. */
export interface CommissionProfileRow {
  id: string;
  name: string | null;
  head_id: string | null;
  status: string;
  termination_date?: string | null;
}

/** Lo mínimo de `commercial_monthly_results` para saber si la línea existe. */
export interface CommissionSavedRow {
  profile_id: string;
  head_id: string | null;
}

export interface UnsavedCommissionGroup {
  headId: string;
  headName: string;
  /** Líneas del grupo (líder incluido). */
  lines: number;
  /** Líneas sin fila guardada. */
  missing: number;
}

export interface UnsavedCommissions {
  /** Líneas sin guardar, sumadas sobre todos los grupos. Es el `count`. */
  totalMissing: number;
  /** Grupos con equipo que se revisaron (completos o no). */
  totalGroups: number;
  /** Líneas revisadas en total. */
  totalLines: number;
  /** SÓLO los grupos con huecos, de más a menos líneas faltantes. */
  groups: UnsavedCommissionGroup[];
}

/** Cuántos grupos nombra el detalle antes de recortar (y avisar). */
export const COMMISSIONS_UNSAVED_MAX_GROUPS = 6;

/**
 * Qué `head_id` cuentan como «la fila de esta línea en este grupo».
 *
 *   · La línea del LÍDER: `head_id` = líder o `null`. La fila propia del head
 *     histórico se guardó con `null` o igual a sí mismo — medido contra
 *     sep-2026 en producción: con esas claves los grupos completos no dan
 *     falso positivo.
 *   · Un MIEMBRO común: `head_id` = líder, `null` (fila vieja sin clave de
 *     grupo) o el propio miembro (bucket propio de los perfiles PnL,
 *     hr/pnl-buckets.ts).
 *   · Un miembro que ES LÍDER de otro grupo (sub-head): SÓLO `head_id` =
 *     líder. Su fila con `null` o consigo mismo es la de SU grupo, no la de
 *     éste; aceptarla haría que guardar el grupo de abajo tapara el hueco en
 *     el de arriba — un falso negativo, que es el fallo que este ítem existe
 *     para atrapar. Es lo mismo que hace la pantalla al guardar: busca la fila
 *     con `head_id` = el grupo seleccionado. Esta restricción NO se midió
 *     contra producción: si algún sub-head guardó su línea de arriba con
 *     `null`, va a aparecer acá. Es un falso positivo VISIBLE, que se mira y
 *     se entiende; el negativo silencioso no se ve nunca. MEDIDO contra
 *     jul-26 y ago-26 en producción (2026-10-18): los 22 sub-heads de Vex Pro
 *     guardaron su línea de arriba con `head_id` = líder (nunca `null` ni el
 *     propio), así que la restricción no genera falsos positivos hoy.
 */
function headIdsAceptados(
  lineId: string,
  leaderId: string,
  lineLeadsAGroup: boolean,
): Array<string | null> {
  if (lineId === leaderId) return [leaderId, null];
  if (lineLeadsAGroup) return [leaderId];
  return [leaderId, null, lineId];
}

/**
 * Líneas de /comisiones sin fila guardada en el período.
 *
 * Devuelve `null` cuando el modelo de negocio no tiene fuerza comercial
 * (`features().commercialTeam`, hoy sólo `broker`): el chequeo no corresponde,
 * que NO es lo mismo que «0 líneas sin guardar» (§1.3).
 */
export function computeUnsavedCommissions(params: {
  businessModel: string | null | undefined;
  profiles: readonly CommissionProfileRow[];
  saved: readonly CommissionSavedRow[];
}): UnsavedCommissions | null {
  if (!features(params.businessModel).commercialTeam) return null;

  // Miembros visibles por líder. Un perfil que se apunta a sí mismo no es su
  // propio equipo.
  const membersByLeader = new Map<string, CommissionProfileRow[]>();
  for (const p of params.profiles) {
    if (!p.head_id || p.head_id === p.id) continue;
    if (!(estaActivo(p) || estaDespedido(p))) continue;
    const list = membersByLeader.get(p.head_id) ?? [];
    list.push(p);
    membersByLeader.set(p.head_id, list);
  }

  const savedKeys = new Set(
    params.saved.map((r) => `${r.profile_id}|${r.head_id ?? ''}`),
  );
  const isSaved = (lineId: string, headId: string | null) =>
    savedKeys.has(`${lineId}|${headId ?? ''}`);

  const groups: UnsavedCommissionGroup[] = [];
  let totalGroups = 0;
  let totalLines = 0;
  let totalMissing = 0;

  // Se itera sobre los perfiles (no sobre el mapa) para que un `head_id` que
  // apunta a un perfil inexistente o de otra empresa no invente un grupo.
  for (const leader of params.profiles) {
    const members = membersByLeader.get(leader.id);
    if (!members || members.length === 0) continue;
    totalGroups += 1;

    const lines = [leader, ...members];
    let missing = 0;
    for (const line of lines) {
      const leadsAGroup = (membersByLeader.get(line.id)?.length ?? 0) > 0;
      const ok = headIdsAceptados(line.id, leader.id, leadsAGroup).some((h) => isSaved(line.id, h));
      if (!ok) missing += 1;
    }
    totalLines += lines.length;
    totalMissing += missing;
    if (missing > 0) {
      groups.push({
        headId: leader.id,
        headName: leader.name?.trim() || '(sin nombre)',
        lines: lines.length,
        missing,
      });
    }
  }

  groups.sort((a, b) => b.missing - a.missing || a.headName.localeCompare(b.headName));
  return { totalMissing, totalGroups, totalLines, groups };
}

/**
 * El detalle legible del ítem: «N líneas sin guardar en M grupos: Luka
 * Angeles (7), Nicolas Skwarok (7), Luis Diaz (1)». Vive acá (y no en la capa
 * de datos) para poder testear el recorte: pasado `max` grupos dice «y K
 * más» — un recorte silencioso es indistinguible de «no hay más» (§1.2).
 *
 * Con todo guardado también devuelve texto, para que el cero sea VISIBLE
 * («se miró y está completo») y no se confunda con «no se miró».
 */
export function formatUnsavedCommissionsDetail(
  r: UnsavedCommissions,
  max: number = COMMISSIONS_UNSAVED_MAX_GROUPS,
): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (r.totalGroups === 0) return 'La empresa no tiene grupos con equipo: nada que verificar.';
  if (r.totalMissing === 0) {
    return `Todas las líneas guardadas (${plural(r.totalLines, 'línea', 'líneas')} en ${plural(
      r.totalGroups,
      'grupo',
      'grupos',
    )}).`;
  }
  const shown = r.groups.slice(0, Math.max(0, max));
  const rest = r.groups.length - shown.length;
  return (
    `${plural(r.totalMissing, 'línea sin guardar', 'líneas sin guardar')} en ${plural(
      r.groups.length,
      'grupo',
      'grupos',
    )}: ` +
    shown.map((g) => `${g.headName} (${g.missing})`).join(', ') +
    (rest > 0 ? ` y ${rest} más` : '')
  );
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
