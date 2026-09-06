import { round2 } from './utils';
import type { CommercialProfile, CommercialMonthlyResult, Period } from '@/lib/types';

// ---------------------------------------------------------------------------
// Rounding helper — avoid float precision issues in monetary calculations
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Commission calculation result for a single user in a single period
// ---------------------------------------------------------------------------

export interface CommissionCalcResult {
  profileId: string;
  netDepositCurrent: number;
  accumulatedIn: number;
  division: number;
  commissionPct: number;
  commission: number;
  realPayment: number;
  accumulatedOut: number;
  salary: number;
  totalEarnedDebt: number;
}

// ---------------------------------------------------------------------------
// Core calculation — implements the corrected accumulation formula
//
// division = net_deposit_current / 2
// base = division + accumulated_in
// commission = base * (percentage / 100)
// real_payment = commission   (SIN clamp — una comisión negativa ES una deuda
//                              del BDM que se arrastra; el modelo de deuda vive
//                              en applyTotalEarnedDebt, no acá)
// accumulated_out = division  (SIEMPRE, positivo o negativo)
//
// ⚠ OJO: no "corregir" esto a MAX(0, commission) ni a arrastrar `base` en
// meses negativos — rompería el arrastre de deuda y pagaría de más. Los tests
// en commission-calculator.test.ts fijan este comportamiento a propósito.
// ---------------------------------------------------------------------------

export function calculateCommission(
  netDepositCurrent: number,
  accumulatedIn: number,
  commissionPct: number,
): Omit<CommissionCalcResult, 'profileId' | 'salary' | 'commissionPct' | 'totalEarnedDebt'> {
  if (netDepositCurrent === 0) {
    // ND=0 significa dos cosas indistinguibles: "mes sin depósitos" o "el
    // operador todavía no cargó el ND" (el default del input es 0). Por eso
    // acá NO se paga nada — pagar sobre accumulatedIn convertiría cada fila
    // sin cargar en un pago fantasma.
    //
    // Lo que SÍ estaba mal (auditoría 2026-08-06): accumulatedOut salía en 0
    // y el acumulado arrastrado se DESTRUÍA — un BDM que venía con $50.000
    // acumulados los perdía para siempre por un mes sin depósitos. Ahora el
    // acumulado se conserva intacto y entra al cálculo del próximo mes con
    // ND real.
    return {
      netDepositCurrent: 0,
      accumulatedIn,
      division: 0,
      commission: 0,
      realPayment: 0,
      accumulatedOut: accumulatedIn,
    };
  }

  const division = round2(netDepositCurrent / 2);
  const commission = round2((division + accumulatedIn) * (commissionPct / 100));
  const realPayment = round2(commission);
  // accumulatedOut siempre es division — positivo o negativo
  const accumulatedOut = division;

  return {
    netDepositCurrent,
    accumulatedIn,
    division,
    commission,
    realPayment,
    accumulatedOut,
  };
}

// ---------------------------------------------------------------------------
// Calculate commissions for an entire HEAD group in a single period
// ---------------------------------------------------------------------------

export function calculateGroupCommissions(
  profiles: CommercialProfile[],
  ndInputs: Map<string, number>,
  accumulatedIns: Map<string, number>,
): CommissionCalcResult[] {
  return profiles.map((profile) => {
    const ndCurrent = ndInputs.get(profile.id) ?? 0;
    const accIn = accumulatedIns.get(profile.id) ?? 0;
    const pct = profile.net_deposit_pct ?? 0;

    const calc = calculateCommission(ndCurrent, accIn, pct);

    return {
      profileId: profile.id,
      commissionPct: pct,
      salary: profile.salary ?? 0,
      totalEarnedDebt: 0,
      ...calc,
    };
  });
}

// ---------------------------------------------------------------------------
// Get accumulated_in for a profile from the previous period's results
// ---------------------------------------------------------------------------

export function getAccumulatedIn(
  previousResults: CommercialMonthlyResult[],
  profileId: string,
  headId?: string,
): number {
  // Primero buscar el registro específico del grupo actual
  if (headId) {
    const prev = previousResults.find(
      (r) => r.profile_id === profileId && r.head_id === headId
    );
    if (prev) return prev.accumulated_out ?? 0;
  }
  // Fallback: cualquier registro del perfil (compatibilidad hacia atrás)
  const prev = previousResults.find((r) => r.profile_id === profileId);
  return prev?.accumulated_out ?? 0;
}

// ---------------------------------------------------------------------------
// Get the previous period in chronological order
// ---------------------------------------------------------------------------

export function getPreviousPeriod(
  periods: Period[],
  currentPeriodId: string,
): Period | null {
  const sorted = [...periods].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });

  const idx = sorted.findIndex((p) => p.id === currentPeriodId);
  return idx > 0 ? sorted[idx - 1] : null;
}

// ---------------------------------------------------------------------------
// Automatic salary calculation based on team total Net Deposit
//
// BDM salary tiers (based on individual ND):
//   ND >= $200,000 → $2,000 USD
//   ND >= $100,000 → $1,000 USD
//   ND >=  $50,000 →   $500 USD
//   ND <   $50,000 →     $0 USD
//
// HEAD / Sales Manager salary tiers (based on full team ND):
//   ND total >= $500,000 → $5,000 USD
//   ND total >= $400,000 → $4,000 USD
//   ND total >= $300,000 → $3,000 USD
//   ND total >= $200,000 → $2,000 USD
//   ND total >= $100,000 → $1,000 USD
//   ND total <  $100,000 →     $0 USD
// ---------------------------------------------------------------------------

export interface SalaryTier {
  minND: number;
  salary: number;
}

// BDM tiers — individual ND
export const SALARY_TIERS: SalaryTier[] = [
  { minND: 200_000, salary: 2_000 },
  { minND: 100_000, salary: 1_000 },
  { minND: 50_000, salary: 500 },
];

// HEAD / Sales Manager tiers — team total ND
export const HEAD_SALARY_TIERS: SalaryTier[] = [
  { minND: 500_000, salary: 5_000 },
  { minND: 400_000, salary: 4_000 },
  { minND: 300_000, salary: 3_000 },
  { minND: 200_000, salary: 2_000 },
  { minND: 100_000, salary: 1_000 },
];

/** BDM salary based on individual ND */
export function calculateSalaryFromND(individualND: number): number {
  if (individualND < 0) return 0;
  const absND = Math.abs(individualND);
  for (const tier of SALARY_TIERS) {
    if (absND >= tier.minND) return tier.salary;
  }
  return 0;
}

/** HEAD / Sales Manager salary based on team total ND */
export function calculateHeadSalaryFromND(teamTotalND: number): number {
  if (teamTotalND < 0) return 0;
  const absND = Math.abs(teamTotalND);
  for (const tier of HEAD_SALARY_TIERS) {
    if (absND >= tier.minND) return tier.salary;
  }
  return 0;
}

/**
 * Prorratea el salario FIJO en el mes de ingreso. Si hire_date cae en el mismo
 * mes/año del período, paga proporcional a los días trabajados (desde el día de
 * ingreso hasta fin de mes, inclusive / días del mes). En cualquier otro mes
 * paga el salario completo. Si no hay hire_date o el período no aplica, devuelve
 * el salario tal cual. Usa UTC para no depender del timezone.
 *
 * Ejemplo: salario 2000, ingreso 2026-06-12, período jun-2026 (30 días) →
 *   días trabajados = 30 − 12 + 1 = 19 → 2000 × 19/30 = 1266.67
 */
export function prorateFixedSalary(
  salary: number,
  hireDate: string | null | undefined,
  periodYear: number,
  periodMonth: number, // 1-12
): number {
  if (!hireDate || !periodYear || !periodMonth) return salary;
  const d = new Date(hireDate);
  if (Number.isNaN(d.getTime())) return salary;
  const hy = d.getUTCFullYear();
  const hm = d.getUTCMonth() + 1;
  const hd = d.getUTCDate();
  // Período ANTES del mes de ingreso: la persona aún no estaba contratada → $0.
  if (periodYear < hy || (periodYear === hy && periodMonth < hm)) return 0;
  // Período DESPUÉS del mes de ingreso: salario completo.
  if (periodYear > hy || (periodYear === hy && periodMonth > hm)) return salary;
  // Mes de ingreso: prorrateo por días trabajados.
  const daysInMonth = new Date(Date.UTC(periodYear, periodMonth, 0)).getUTCDate();
  const daysWorked = Math.max(0, Math.min(daysInMonth, daysInMonth - hd + 1));
  return round2((salary * daysWorked) / daysInMonth);
}

// ---------------------------------------------------------------------------
// BDM commission percentage tiers — based on individual ND
//
//   ND >= $200,000 → 6%
//   ND >= $100,000 → 5%
//   ND >=  $50,000 → 4%
//   ND <   $50,000 → 0% (profile default)
// ---------------------------------------------------------------------------

export interface PctTier {
  minND: number;
  pct: number;
}

export const BDM_PCT_TIERS: PctTier[] = [
  { minND: 200_000, pct: 6 },
  { minND: 100_000, pct: 5 },
  { minND: 50_000, pct: 4 },
];

/** BDM commission percentage based on individual ND.
 *  If ND < $50,000, returns null so the caller can fall back to the profile default. */
export function calculateBdmPctFromND(
  individualND: number,
  profilePct?: number,
  /**
   * true = el % del perfil es FIJO y los tramos NO aplican (ni para subir).
   * Excepción por perfil (`commercial_profiles.nd_pct_fixed`, migración 128),
   * pedida el 2026-09-03: Ana García tiene 4% pactado y un agosto de $283K la
   * subía al 6% del tramo. El default (false/undefined) conserva la regla del
   * piso de la auditoría 2026-08-06 tal cual.
   */
  pctFixed?: boolean,
): number {
  if (pctFixed) return profilePct ?? 0;
  let tierPct = 0;
  if (individualND >= 0) {
    for (const tier of BDM_PCT_TIERS) {
      if (individualND >= tier.minND) { tierPct = tier.pct; break; }
    }
  }
  // El tier es un PISO por volumen, nunca un techo: un BDM con 7% negociado
  // y ND de $120K cobraba al 5% de la tabla, en silencio (auditoría
  // 2026-08-06). El % del perfil es el acuerdo; el tier solo puede mejorarlo.
  return Math.max(tierPct, profilePct ?? 0);
}

/**
 * EL % QUE MANDA ESTE MES.
 *
 * `commercial_monthly_results.pct_override` (migración 129, pedido del dueño el
 * 2026-09-06) fija a mano el % de UN mes sin tocar el acuerdo del perfil: pisa
 * los tramos por volumen, `nd_pct_fixed` y `net_deposit_pct`.
 *
 * ── null ≠ 0, y acá se paga la diferencia ──────────────────────────────────
 * `null`/`undefined` = "no hay override" → manda el automático que ya venía
 * calculado. `0` = "este mes no cobra comisión" y es un valor VÁLIDO. Un
 * `override || automatico` habría tratado el 0 tecleado como "no hay nada
 * cargado" y le habría pagado igual, sin lanzar ninguna excepción (§1.2/§1.3).
 * Por eso `??` y por eso esto es una función con nombre y no un operador
 * suelto repetido en cada pantalla: son tres los lugares que deciden este
 * número (tab Equipos, tab Individual y el guardado) y tienen que decidirlo
 * igual (§1.1, §2.1 "un mismo número sale del mismo camino").
 *
 * Un override negativo o disparatado NO se clampea acá: el % del perfil
 * tampoco se clampea y la pantalla es la que valida lo que se teclea.
 */
export function resolvePctDelMes(
  pctOverride: number | null | undefined,
  pctAutomatico: number,
): number {
  return pctOverride ?? pctAutomatico;
}

/**
 * EL % PROPIO DEL LÍDER DE UN GRUPO (tab Equipos).
 *
 * Un grupo lo puede liderar un head/sales_manager o —desde el pedido del dueño
 * del 2026-09-06— un BDM con Master IBs colgados («que aparezca acá en equipo…
 * porque ahí la quiero calcular como se calculan en equipo»). El grupo se
 * calcula igual en los dos casos; lo único que cambia es de dónde sale el %
 * PROPIO del líder, y por eso esa decisión vive acá y no inline en la pantalla:
 * la toman la tabla del tab Equipos Y el guardado, y tienen que tomarla igual
 * (§2.1: «un mismo número sale del mismo camino»).
 *
 *   · head / sales_manager → su `net_deposit_pct` pactado, tal cual. Sin
 *     tramos: un líder cobra lo pactado, no lo que le dé el volumen del mes.
 *     Es la rama de siempre y no cambia un centavo.
 *   · BDM que lidera su grupo → se resuelve **como BDM**: tramos por volumen
 *     (piso, nunca techo — regla 3 del §2.1), la excepción `nd_pct_fixed`
 *     (migración 128) y el `pct_override` del mes (129). Liderar un grupo NO
 *     le saca a Ana sus tramos: es la MISMA persona que en el grupo de Luka
 *     cobra su % de BDM, y los dos caminos tienen que dar el mismo número —
 *     si acá se leyera `net_deposit_pct` a secas, un mes de $283K le pagaría
 *     al 4% en una pantalla y al 6% en la otra, sin lanzar ninguna excepción.
 *   · `fixed_salary` apaga los tramos, exactamente como en `bdmCalcs`: es el
 *     mismo criterio con el que se le calcula la línea bajo su propio head.
 */
export function pctPropioDelLiderDeGrupo(params: {
  /** El líder del grupo es un BDM (no head ni sales_manager). */
  liderEsBdm: boolean;
  /** `net_deposit_pct` del perfil. */
  profilePct: number;
  /** ND propio del mes — sólo se usa para tierizar a un BDM. */
  nd: number;
  ndPctFixed?: boolean | null;
  fixedSalary?: boolean | null;
  /** `pct_override` del mes; `null` = automático (§1.3: 0 es una decisión). */
  pctOverride?: number | null;
}): number {
  if (!params.liderEsBdm) return params.profilePct;
  const auto = params.fixedSalary
    ? params.profilePct
    : calculateBdmPctFromND(params.nd, params.profilePct, params.ndPctFixed ?? false);
  return resolvePctDelMes(params.pctOverride, auto);
}

/**
 * EL % PROPIO DE UNA LÍNEA DEL GRUPO — el del de abajo, con el que se calcula
 * el diferencial del de arriba.
 *
 * Es la precedencia que ya vivía inline en `bdmCalcs` y en el guardado del tab
 * Equipos, extraída para que los dos la decidan igual (§2.1), MÁS una condición
 * nueva. En orden:
 *
 *   · sub-HEAD o `fixed_salary` → su % pactado, sin tramos. Lo de siempre.
 *   · línea de un grupo liderado por un BDM (un MASTER IB) → su % pactado
 *     también, `?? 0`. **Los tramos de % por volumen son la escalera de un BDM
 *     empleado y un master no está en ella.** Tierizarlo paga mal y en
 *     silencio: el master no suele tener `net_deposit_pct`, así que
 *     `calculateBdmPctFromND(283.139, 0)` le devolvía el 6% del tramo, el
 *     diferencial natural de la BDM caía a 6 − 6 = 0 y ella cobraba NADA por
 *     la línea que el dueño dijo explícitamente que cobra («ella sí gana un
 *     porcentaje de millonarios team»). Con el % en 0, el natural es el %
 *     COMPLETO del BDM, que es justo lo que la migración 130 documenta.
 *   · BDM normal bajo un head → los tramos de siempre (piso, nunca techo).
 *
 * La condición nueva sólo se enciende dentro del grupo de un BDM: en un grupo
 * de head no cambia un centavo.
 */
export function pctPropioDeLineaDeGrupo(params: {
  /** El grupo lo lidera un BDM (la línea es la de un Master IB). */
  grupoLideradoPorBdm: boolean;
  /** El de abajo tiene equipo propio o es head/sales_manager. */
  esSubHead: boolean;
  profilePct: number;
  nd: number;
  ndPctFixed?: boolean | null;
  fixedSalary?: boolean | null;
}): number {
  if (params.grupoLideradoPorBdm || params.esSubHead || params.fixedSalary) return params.profilePct;
  return calculateBdmPctFromND(params.nd, params.profilePct, params.ndPctFixed ?? false);
}

/**
 * EL DIFERENCIAL NATURAL DE UNA LÍNEA — lo que el de arriba cobra por el de
 * abajo cuando nadie configuró nada.
 *
 * Estaba escrito inline en `bdmCalcs` (/comisiones, tab Equipos) y es donde
 * viven DOS reglas del §2.1 que no se rompen:
 *
 *   · regla 7 — el diferencial del HEAD **nunca es negativo**. Si el BDM
 *     tieriza por encima de su head, el head cobra 0 por esa línea, no paga
 *     por el buen mes de su BDM (auditoría 2026-08-06: head al 5% con un BDM
 *     tierizado al 6% le restaba $1.000 al head).
 *   · regla 8 — `extra_pct` aplica **sólo** cuando el natural es exactamente
 *     0 (mismo %). Con natural > 0 no se suma, y con natural < 0 no rescata
 *     nada: el clamp manda.
 *
 * `refPct` es el % de referencia del de arriba: su `net_deposit_pct`, o
 * `pct_sobre_bdm_global` cuando el de abajo es BDM GLOBAL. `pctPropio` es el
 * % ya resuelto del de abajo (tramos + `nd_pct_fixed` + `pct_override` del
 * mes) — este cálculo no lo re-deriva, lo recibe.
 */
export function diffNaturalDeLinea(
  refPct: number,
  pctPropio: number,
  extraPct: number,
): number {
  const natural = refPct - pctPropio;
  return natural > 0 ? natural : natural === 0 ? extraPct : 0;
}

/**
 * EL % QUE COBRA EL DE ARRIBA POR ESTA LÍNEA (migración 130, pedido del dueño
 * el 2026-09-06).
 *
 * `commercial_profiles.pct_linea` vive en el HIJO y significa «el % que cobra
 * el de arriba por la línea de este perfil». Pisa el diferencial de esa línea
 * sobre la MISMA base de siempre (división del ND + acumulado): lo único que
 * cambia es el porcentaje. El caso: Luka cobrando 1% por la línea de Ana sin
 * subirle el % a Ana.
 *
 * ── null ≠ 0, otra vez ─────────────────────────────────────────────────────
 * `null`/`undefined` = «no hay pisada» → manda el diferencial natural. `0` =
 * «el de arriba no cobra nada por esta línea» y es un valor VÁLIDO. Un
 * `pisada || natural` habría tratado ese cero como campo vacío y habría
 * pagado el diferencial igual, sin lanzar excepción (§1.2/§1.3). Por eso `??`,
 * y por eso esto es una función con nombre —al lado de `resolvePctDelMes`, por
 * el mismo motivo— y no un operador suelto repetido: son varios los lugares
 * que deciden este número (la tabla del tab Equipos, el guardado, el PDF y el
 * CSV de equipo) y tienen que decidirlo igual (§1.1, §2.1 «un mismo número
 * sale del mismo camino»).
 *
 * ── El clamp NO se le aplica a la pisada ───────────────────────────────────
 * El «nunca negativo» de la regla 7 vive dentro de `diffNaturalDeLinea`, o
 * sea en la rama natural. Si el dueño pone 1% donde el natural daba 0, el de
 * arriba cobra 1%: eso es el pedido, no un accidente. Y una pisada MAYOR que
 * el % del head también se permite —es un acuerdo, no un derivado— igual que
 * `pct_override` tampoco se clampea. Lo que valida lo tecleado es la pantalla.
 */
export function resolveDiffPctDeLinea(
  pctLinea: number | null | undefined,
  diffNatural: number,
): number {
  return pctLinea ?? diffNatural;
}

// ---------------------------------------------------------------------------
// HEAD differential calculation
//
// When a HEAD has BDMs, the HEAD earns the DIFFERENTIAL percentage on each
// BDM's ND, using the same formula (ND/2 + accumulated × diff%).
//
// diff_pct = (head_pct - bdm_pct) + extra_pct
//
// Example: HEAD 7%, BDM 4%, extra 0% → diff = 3%
// Example: HEAD 4%, BDM 4%, extra 1% → diff = 1%
// ---------------------------------------------------------------------------

export interface DifferentialDetail {
  bdmProfileId: string;
  bdmName: string;
  bdmNd: number;
  bdmPct: number;
  diffPct: number;
  division: number;
  commission: number;
  realPayment: number;
}

export interface HeadDifferentialResult {
  totalDifferential: number;
  totalRealPayment: number;
  details: DifferentialDetail[];
}

export function calculateHeadDifferential(
  headPct: number,
  extraPct: number,
  /**
   * `pctLinea` (migración 130) = el `commercial_profiles.pct_linea` del BDM:
   * pisa el diferencial de ESA línea. `null`/ausente = el de siempre.
   */
  bdmResults: { profileId: string; name: string; netDepositCurrent: number; accumulatedIn: number; commissionPct: number; pctLinea?: number | null }[],
): HeadDifferentialResult {
  const details: DifferentialDetail[] = bdmResults.map((bdm) => {
    // OJO: la rama natural de acá NO es la de la pantalla — suma `extraPct`
    // siempre y no clampea el diferencial (sólo el pago real, más abajo). Se
    // deja tal cual a propósito: sus tests fijan ese comportamiento y el
    // camino de producción es `bdmCalcs` + `diffNaturalDeLinea` (§2.1 regla
    // 7/8). Lo que SÍ se comparte es la precedencia de la pisada por línea,
    // que tiene que decidirse en un solo lugar (§1.1).
    const diffPct = resolveDiffPctDeLinea(bdm.pctLinea, (headPct - bdm.commissionPct) + extraPct);
    const division = round2(bdm.netDepositCurrent / 2);
    const commission = round2((division + bdm.accumulatedIn) * (diffPct / 100));
    const realPayment = round2(Math.max(0, commission));

    return {
      bdmProfileId: bdm.profileId,
      bdmName: bdm.name,
      bdmNd: bdm.netDepositCurrent,
      bdmPct: bdm.commissionPct,
      diffPct,
      division,
      commission,
      realPayment,
    };
  });

  const totalDifferential = round2(details.reduce((sum, d) => sum + d.commission, 0));
  const totalRealPayment = round2(details.reduce((sum, d) => sum + d.realPayment, 0));

  return { totalDifferential, totalRealPayment, details };
}

// ---------------------------------------------------------------------------
// Group summary totals
// ---------------------------------------------------------------------------

export interface GroupSummary {
  totalRealPayment: number;
  totalSalary: number;
  totalWithSalary: number;
  totalCommission: number;
}

export function calculateGroupSummary(
  results: CommissionCalcResult[],
): GroupSummary {
  const totalRealPayment = round2(results.reduce((sum, r) => sum + r.realPayment, 0));
  const totalSalary = round2(results.reduce((sum, r) => sum + r.salary, 0));
  const totalCommission = round2(results.reduce((sum, r) => sum + r.commission, 0));

  return {
    totalRealPayment,
    totalSalary,
    totalWithSalary: round2(totalRealPayment + totalSalary),
    totalCommission,
  };
}

// ---------------------------------------------------------------------------
// Apply accumulated debt to total_earned
//
// previousDebt: valor del campo `bonus` del mes anterior (deuda acumulada)
//   - si es negativo: hay deuda que restar
//   - si es 0 o positivo: no hay deuda
// currentRaw: realPayment + salary del mes actual (antes de deuda)
//
// Returns:
//   finalTotalEarned → valor a mostrar y guardar en total_earned
//   debtOut → valor a guardar en `bonus` (deuda para el siguiente mes, 0 si no hay)
// ---------------------------------------------------------------------------
export function applyTotalEarnedDebt(
  previousDebt: number,
  currentRaw: number,
): { finalTotalEarned: number; debtOut: number } {
  // Sin deuda del mes anterior
  if (previousDebt >= 0) {
    const finalTotalEarned = round2(currentRaw);
    const debtOut = finalTotalEarned < 0 ? finalTotalEarned : 0;
    return { finalTotalEarned, debtOut };
  }
  // Aplicar deuda acumulada
  const afterDebt = round2(currentRaw + previousDebt);
  if (afterDebt >= 0) {
    // Se saldó la deuda
    return { finalTotalEarned: afterDebt, debtOut: 0 };
  } else {
    // Sigue en deuda — acumular para el siguiente mes
    return { finalTotalEarned: afterDebt, debtOut: afterDebt };
  }
}

// ---------------------------------------------------------------------------
// PnL SPECIAL MODE
// ---------------------------------------------------------------------------
//
// Cálculo alternativo para perfiles con `pnl_special_mode = true`:
//
//   commission      = pnl × pnl_pct                ← sin dividir entre 2
//   real_payment    = commission − com_lotes
//   accumulated_out = 0                            ← no lleva acumulado
//
// La resta de Com. Lotes (lotCommissions) SÍ se aplica, igual que en PnL
// normal. Las diferencias clave son:
//   1. No se divide el PnL entre 2
//   2. No se considera `accumulated_in` del mes anterior
//   3. No se pasa `accumulated_out` al siguiente mes
//
// Esta función es INDEPENDIENTE de `calculateCommission`. Mantenerlas
// aisladas protege el cálculo normal de efectos colaterales por cambios
// futuros en el modo Especial.
// ---------------------------------------------------------------------------

export interface PnlSpecialCalcResult {
  profileId: string;
  pnl: number;              // PnL de entrada (lo que pusimos en el input)
  commissionPct: number;    // % del perfil
  commission: number;       // pnl × pct
  lotCommissions: number;   // Com. Lotes restadas
  realPayment: number;      // commission − lotCommissions
  accumulatedOut: number;   // SIEMPRE 0 en modo Especial
  salary: number;           // salario fijo si aplica; sin tiers
}

export function calculatePnlSpecial(
  pnl: number,
  pnlPct: number,
  lotCommissions: number,
  salary: number = 0,
): Omit<PnlSpecialCalcResult, 'profileId'> {
  const commission = round2(pnl * (pnlPct / 100));
  const realPayment = round2(commission - lotCommissions);
  return {
    pnl,
    commissionPct: pnlPct,
    commission,
    lotCommissions,
    realPayment,
    accumulatedOut: 0,
    salary,
  };
}

// ---------------------------------------------------------------------------
// UN MES DE LA CADENA DEL GRUPO PnL
//
// Existe por el recálculo «desde abril» de /comisiones (2026-09-02): reescribir
// varios meses seguidos con el insumo del CRM obliga a encadenar DOS estados de
// un mes al siguiente —la deuda (`bonus`) y el acumulado (`accumulated_out`)—
// y a hacerlo con el valor RECIÉN calculado, no con el guardado viejo. Esa
// cadena es la misma que ya rige la distribución a socios (§2.2): *"hay que
// procesar todos los períodos en orden cronológico o el arrastre diverge"*.
//
// Es pura y vive acá —y no en la pantalla— por el invariante A3 de §2.1: *un
// mismo número tiene que salir del mismo camino*. Este paso NO inventa fórmula:
// llama a `calculateCommission` / `calculatePnlSpecial` y a
// `applyTotalEarnedDebt` exactamente como lo hace `handleSaveBdm`, así que
// recalcular un mes solo da el mismo peso que guardarlo a mano.
//
// Lo que NO decide: de dónde salen `pnl`, `lotCommissions` y `salary`. El signo
// del PnL ya viene dado vuelta desde /api/admin/commission-net-input (único
// punto de inversión) y el salario lo conserva quien llama.
// ---------------------------------------------------------------------------

export interface PnlChainState {
  /** `bonus` del mes anterior. NEGATIVO = deuda arrastrada (§2.1 regla 6). */
  prevDebt: number;
  /** `accumulated_out` del mes anterior. En modo Especial no se usa (siempre 0). */
  accumulatedIn: number;
}

/** Una fila de `commercial_monthly_results`, más el estado que entra al mes siguiente. */
export interface PnlChainStep {
  netDepositCurrent: number;
  netDepositAccumulated: number;
  division: number;
  commissionsEarned: number;
  realPayment: number;
  pnlCurrent: number;
  accumulatedOut: number;
  salaryPaid: number;
  totalEarned: number;
  bonus: number;
  /** Lo que hay que pasarle a ESTE mismo perfil el mes siguiente. */
  next: PnlChainState;
}

export function calcularPasoPnlEncadenado(params: {
  /** 'special' = perfiles con `pnl_special_mode`; 'normal' = el resto del grupo PnL. */
  mode: 'normal' | 'special';
  pnlPct: number;
  /** El PnL del mes YA con el signo de la pantalla (lo que la empresa gana). */
  pnl: number;
  /** Com. Lotes del mes. Se RESTAN del pago real en los dos modos. */
  lotCommissions: number;
  /** Salario del mes. El recálculo lo conserva del guardado, no lo re-tieriza. */
  salary: number;
  state: PnlChainState;
}): PnlChainStep {
  const { mode, pnlPct, pnl, lotCommissions, salary, state } = params;

  if (mode === 'special') {
    // Aislado de calculateCommission a propósito (§2.1 regla 5): sin división,
    // sin acumulado de entrada y sin acumulado de salida. Lo único que cruza al
    // mes siguiente es la deuda.
    const calc = calculatePnlSpecial(pnl, pnlPct, lotCommissions, salary);
    const { finalTotalEarned, debtOut } = applyTotalEarnedDebt(
      state.prevDebt,
      calc.realPayment + calc.salary,
    );
    return {
      netDepositCurrent: calc.pnl,
      netDepositAccumulated: 0,
      division: 0,
      commissionsEarned: calc.commission,
      realPayment: calc.realPayment,
      pnlCurrent: calc.lotCommissions,
      accumulatedOut: 0,
      salaryPaid: calc.salary,
      totalEarned: finalTotalEarned,
      bonus: debtOut,
      next: { prevDebt: debtOut, accumulatedIn: 0 },
    };
  }

  // Modo normal: la MISMA fórmula del net deposit (ND/2 + acumulado × pct) pero
  // con `pnl_pct` y sin tiers de salario, que es lo que hace `pnlCalcs`.
  const calc = calculateCommission(pnl, state.accumulatedIn, pnlPct);
  const realPayment = round2(calc.realPayment - lotCommissions);
  const { finalTotalEarned, debtOut } = applyTotalEarnedDebt(state.prevDebt, realPayment + salary);
  return {
    netDepositCurrent: calc.netDepositCurrent,
    netDepositAccumulated: calc.accumulatedIn,
    division: calc.division,
    commissionsEarned: calc.commission,
    realPayment,
    pnlCurrent: lotCommissions,
    // Con PnL = 0 el acumulado se CONSERVA (calculateCommission lo garantiza):
    // un mes sin dato no puede borrarle el arrastre a nadie (§2.1 regla 2).
    accumulatedOut: calc.accumulatedOut,
    salaryPaid: salary,
    totalEarned: finalTotalEarned,
    bonus: debtOut,
    next: { prevDebt: debtOut, accumulatedIn: calc.accumulatedOut },
  };
}

// NOTA: el BDM GLOBAL NO usa una función aparte. Por definición del negocio,
// el HEAD le aplica el MISMO cálculo de diferencial que a un BDM normal —
// lo único que cambia es la referencia: usa pct_sobre_bdm_global en lugar de
// su net_deposit_pct. Esa lógica vive en bdmCalcs (comisiones/page.tsx), no acá.

// ---------------------------------------------------------------------------
// EXTRA SOBRE HEAD — Cálculo del HEAD/Sales Manager superior sobre HEAD intermedio
//
// Cuando el HEAD/Sales Manager tiene OTRO HEAD bajo su estructura:
//   - Si ese HEAD intermedio tiene salario fijo:
//       commission = (suma_ND_BDMs_del_HEAD / 2 + acum_in) × (pct_extra_sobre_head / 100)
//   - Si ese HEAD intermedio NO tiene salario fijo:
//       - Si el HEAD superior tiene apply_pct_extra_to_head_without_salary = true:
//           usar la misma fórmula
//       - Si NO: usar el cálculo de diferencial normal (calculateHeadDifferential existente)
//
// La función decide cuándo aplicar y cuándo NO basándose en los flags del HEAD intermedio
// y del HEAD superior.
// ---------------------------------------------------------------------------

export interface ExtraOverHeadCommissionResult {
  headIntermediateProfileId: string;
  headIntermediateName: string;
  hasFixedSalary: boolean;
  sumNdBdms: number;
  accumulatedIn: number;
  pctApplied: number;
  division: number;
  commission: number;
  realPayment: number;
  accumulatedOut: number;
}

export function calculateExtraOverHeadCommission(
  pctExtraSobreHead: number,
  applyPctExtraWithoutSalary: boolean,
  headIntermediateResults: {
    profileId: string;
    name: string;
    hasFixedSalary: boolean;
    sumNdBdms: number;
    accumulatedIn: number;
  }[],
): {
  totalCommission: number;
  totalRealPayment: number;
  details: ExtraOverHeadCommissionResult[];
  skipped: { profileId: string; name: string; reason: string }[];
} {
  const details: ExtraOverHeadCommissionResult[] = [];
  const skipped: { profileId: string; name: string; reason: string }[] = [];

  for (const h of headIntermediateResults) {
    // Decidir si aplica la nueva regla o se salta
    const shouldApply = h.hasFixedSalary || applyPctExtraWithoutSalary;
    if (!shouldApply) {
      skipped.push({
        profileId: h.profileId,
        name: h.name,
        reason: 'HEAD sin salario fijo y flag apply_pct_extra_to_head_without_salary=false',
      });
      continue;
    }

    const division = round2(h.sumNdBdms / 2);
    const commission = round2((division + h.accumulatedIn) * (pctExtraSobreHead / 100));
    // El pago real puede ser NEGATIVO (clawback por ND negativo), igual que en
    // calculateCommission. No se clampea a 0: si el equipo del sub-HEAD tuvo ND
    // negativo, ese negativo debe restar en el total del grupo, consistente con
    // los BDMs y el HEAD principal en la misma vista.
    const realPayment = round2(commission);
    const accumulatedOut = division;

    details.push({
      headIntermediateProfileId: h.profileId,
      headIntermediateName: h.name,
      hasFixedSalary: h.hasFixedSalary,
      sumNdBdms: h.sumNdBdms,
      accumulatedIn: h.accumulatedIn,
      pctApplied: pctExtraSobreHead,
      division,
      commission,
      realPayment,
      accumulatedOut,
    });
  }

  const totalCommission = round2(details.reduce((s, d) => s + d.commission, 0));
  const totalRealPayment = round2(details.reduce((s, d) => s + d.realPayment, 0));

  return { totalCommission, totalRealPayment, details, skipped };
}
