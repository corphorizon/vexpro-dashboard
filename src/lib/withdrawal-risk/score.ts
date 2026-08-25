// ─────────────────────────────────────────────────────────────────────────────
// Score de riesgo de retiro — scorecard bayesiano, determinista y explicable.
//
// ╔═══════════════════════════════════════════════════════════════════════════╗
// ║ REGLA DURA: EL SCORE NUNCA DECIDE.                                        ║
// ║ Es orientación para que el analista mire primero lo que más lo merece.    ║
// ║ Aprobar o rechazar lo firma una persona; el número sólo ordena la cola y  ║
// ║ explica por qué. Además este módulo NO ejecuta nada en el CRM: somos      ║
// ║ solo-lectura sobre Mongo.                                                 ║
// ╚═══════════════════════════════════════════════════════════════════════════╝
//
// ── MODELO ELEGIDO: naive Bayes en log-odds (scorecard de "weight of evidence")
//
// Por qué éste y no un árbol / regresión logística entrenada:
//   · Es EXPLICABLE por construcción: el score final es la suma de sumandos,
//     y cada sumando ES un factor que se le muestra al humano con su número.
//     Un GBM daría un punto más de AUC y cero capacidad de defender la
//     decisión ante compliance.
//   · Es AUDITABLE: los pesos no son coeficientes opacos, son la tasa de
//     rechazo observada de cada tramo. Cualquiera puede recorrer la tabla de
//     abajo y volver a medirla contra el histórico.
//   · Es ESTABLE con pocos datos: 915 rechazos no alcanzan para entrenar algo
//     con interacciones sin sobreajustar.
//   · Es DETERMINISTA y puro: mismo input → mismo output, sin reloj ni red,
//     que es lo que permite congelar el score en `withdrawal_reviews`.
//
// La aritmética:
//   logOdds = logOdds(tasa base de APROBACIÓN)
//           + WoE(tramo de rechazos previos)
//           + λ · [ WoE(ratio) + WoE(antigüedad) + WoE(neto) ]
//   approvalScore = 100 · sigmoide(logOdds)
//
// donde WoE(tramo) = ln((1−r)/r) − ln((1−base)/base), con `r` = tasa de rechazo
// MEDIDA de ese tramo. Un WoE positivo empuja a aprobar, negativo a rechazar,
// y 0 significa "este tramo se comporta como el promedio".
//
// ── λ: POR QUÉ HAY UN AMORTIGUADOR (0,8) ────────────────────────────────────
// Naive Bayes supone señales independientes y las nuestras NO lo son:
// `ratio` y `netBefore` comparten el MISMO denominador (`depositedBefore`), y
// una cuenta de menos de un día casi por definición tiene pocos depósitos. Sin
// amortiguar, el mismo hecho ("este cliente casi no depositó") se cobra tres
// veces. Los rechazos previos, en cambio, son una señal limpia y dominante
// (2,14% → 47,78% de rechazo) y entran con peso completo.
//
// λ NO se eligió a ojo: se barrió contra los 9.785 retiros resueltos de la
// ventana (backtest in-sample, log-loss / AUC / calibración por decil):
//
//     λ = 1,0   AUC 0,8635   log-loss 0,1378
//     λ = 0,8   AUC 0,8626   log-loss 0,1376   ← elegido
//     λ = 0,6   AUC 0,8620   log-loss 0,1391
//     λ = 0,4   AUC 0,8626   log-loss 0,1419
//
// Conclusión honesta: la corrección importa poco (el AUC casi no se mueve),
// pero 0,8 da la mejor log-loss y la mejor calibración del decil más riesgoso
// (predice 69,1% de aprobación, se observa 67,2%; con λ=0,6 predice 69,8% y
// con λ=0,4 el segundo decil se va a 96,4% predicho contra 93,9% observado,
// o sea aplanar empeora). Se deja expuesto en la calibración para poder
// re-medirlo cuando cambie la ventana.
//
// ── SEÑALES DESCARTADAS — NO TOCAR, ESTÁN MEDIDAS ───────────────────────────
// Estas tres PARECEN señales de fraude y no lo son. Se muestran en la ficha
// como contexto, pero tienen peso CERO y no existe un tramo para ellas en la
// tabla de calibración. Si alguien las "agrega" creyendo que faltaban, va a
// empeorar el modelo. Los números:
//
//   1. KYC — los 915 rechazos del histórico son TODOS de usuarios VERIFIED.
//      Los 95 retiros de usuarios con KYC 'NONE' tienen 0% de rechazo. Tiene
//      sentido: al CRM no se le pide retirar sin KYC, así que el estado no
//      discrimina nada; lo único que "predice" es quién llegó a pedir.
//   2. Deuda de comisiones (`pendingFeeDebt`) — 34 casos en todo el histórico,
//      0 rechazos. Muestra insuficiente y sin señal: no es material.
//   3. Dirección de destino compartida entre usuarios — 6,18% de rechazo
//      cuando la dirección la comparten varios contra 7,39% cuando es propia.
//      O sea: las compartidas se rechazan MENOS. Son exchanges y custodios
//      legítimos (una dirección de depósito de Binance la usan miles), no
//      colusión. Usarla como señal de fraude penalizaría al cliente normal.
//
// ── DERIVA TEMPORAL ─────────────────────────────────────────────────────────
// El criterio del equipo cambió con el tiempo: la tasa de rechazo mensual fue
// 3,46% (dic-25) → 15,75% (ene-26) → 26,51% (feb-26) → 11,93% (mar) → 8,40%
// (abr) → 5,92% (may) → 2,37% (jun) → 2,14% (jul) → 3,65% (ago-26). Un score
// calibrado contra TODO el histórico le habla al criterio de febrero, no al de
// hoy. Por eso el preset por defecto es `RECENT_6M` (ventana de 6 meses,
// 9.785 retiros resueltos, base 5,10%) y no `FULL_HISTORY` (12.922, base
// 7,08%), que queda disponible para comparar. Efecto de cambiar de ventana:
// la ventana reciente sube la base de aprobación de 92,92% a 94,90% (todo el
// mundo puntúa un poco mejor) Y separa MÁS los rechazos previos, porque en el
// régimen actual un rechazo anterior es más excepcional y por lo tanto más
// informativo. Los cortes de banda están atados a la base, así que se mueven
// solos con la ventana (ver `bandsFor`).
// ─────────────────────────────────────────────────────────────────────────────

import type {
  AgeBucket,
  NetBucket,
  P2pBucket,
  RatioBucket,
  RejectionBucket,
  WithdrawalFeatures,
} from './features';

export type RiskBand = 'low' | 'medium' | 'high';
export type FactorImpact = 'up' | 'down' | 'neutral';

export interface ScoreFactor {
  /** Identificador estable (para i18n / filtros). */
  code: 'prior_rejections' | 'amount_ratio' | 'account_age' | 'net_before' | 'money_origin';
  /** Etiqueta corta en español. */
  label: string;
  /** 'up' = empuja a aprobar, 'down' = empuja a rechazar, 'neutral' = como el promedio. */
  impact: FactorImpact;
  /** Aporte en log-odds YA amortiguado. Positivo suma al score. */
  weight: number;
  /** Explicación en español, con el número medido. */
  detail: string;
}

export interface ScoreResult {
  /** 0-100: probabilidad estimada de que este retiro se APRUEBE. */
  approvalScore: number;
  /** Banda de RIESGO (ojo: alta banda = score bajo). */
  band: RiskBand;
  factors: ScoreFactor[];
  /** Log-odds final, para depurar / re-calibrar. */
  logOdds: number;
  /** Qué calibración se usó (queda registrado junto a la decisión). */
  calibrationId: string;
}

// ── Tabla de calibración ─────────────────────────────────────────────────────
// Cada número es la TASA DE RECHAZO OBSERVADA del tramo, medida sobre
// crm_withdrawals con status_norm in ('approved','rejected') y comportamiento
// calculado punto-en-el-tiempo. Los `n` van al lado para que se vea cuánta
// evidencia hay detrás de cada celda: los tramos flacos (antigüedad <1d, n=60)
// mueven mucho el score con poca muestra y hay que mirarlos con desconfianza.

export interface Calibration {
  id: string;
  /** Descripción legible de la ventana. */
  window: string;
  /** Nº de retiros resueltos que la sostienen. */
  n: number;
  /** Tasa de rechazo base de la ventana. */
  baseRejectionRate: number;
  /** Amortiguador de las señales correlacionadas (ver cabecera). */
  lambda: number;
  /** Multiplicador de la base que marca el corte de riesgo alto (ver `bandsFor`). */
  highBandMultiple: number;
  rejections: Record<RejectionBucket, number>;
  ratio: Record<RatioBucket, number>;
  age: Record<Exclude<AgeBucket, 'unknown'>, number>;
  net: Record<NetBucket, number>;
  /**
   * Origen del dinero. La señal más fuerte del módulo, y la única que salió de
   * una intuición de Kevin que resultó correcta — aunque no por el motivo que
   * suponía: no es "retiró más de lo que depositó" (eso NO predice), es de
   * dónde vino ese dinero.
   */
  p2p: Record<P2pBucket, number>;
}

/**
 * Ventana reciente (6 meses hasta 2026-08-24) — LA QUE SE USA.
 * Refleja el criterio ACTUAL del equipo, no el de febrero.
 */
export const RECENT_6M: Calibration = {
  id: 'recent_6m@2026-08-24',
  window: 'últimos 6 meses',
  n: 9785,
  baseRejectionRate: 0.0510, // 499 rechazos / 9.785 resueltos
  lambda: 0.8,
  highBandMultiple: 3.5,
  // n = 8.835 / 515 / 165 / 270
  rejections: { r0: 0.0214, r1: 0.2330, r2: 0.3697, r3plus: 0.4778 },
  // CORREGIDO 2026-08-24 tras verificación independiente: los tramos centrales
  // estaban INVERTIDOS (b_0_5_1 tenía 0,0772 y b_1_2 0,1385). Re-medido tres
  // veces con los buckets EXACTOS de ratioBucketOf ([0,5–1) y [1–2)) y en tres
  // ventanas distintas: 0,5–1x SIEMPRE rechaza más que 1–2x (6m: 12,39 vs 6,14;
  // completo: 14,21 vs 8,37; anterior a 6m: 18,12 vs 13,49). Con los pesos
  // invertidos el score castigaba a quien pide 1–2x y premiaba a quien pide
  // 0,5–1x, que es justo al revés de lo que muestra la historia.
  // n = 5.969 / 1.630 / 863 / 379 / 944
  ratio: { lt_0_5: 0.0260, b_0_5_1: 0.1239, b_1_2: 0.0614, gt_2: 0.1003, no_deposits: 0.0540 },
  // Medido el 2026-08-25 en esta misma ventana, n = 411 / 7.723 / 575 / 1.119.
  // Monótona: cuanto más cubre el P2P al retiro, más se rechaza.
  p2p: { staff: 0.0170, none: 0.0390, partial: 0.0835, covers: 0.1162 },
  // n = 60 / 600 / 2.142 / 6.982
  age: { lt_1d: 0.2167, b_1_7d: 0.0917, b_7_30d: 0.0345, gt_30d: 0.0511 },
  // n = 890 / 1.151 / 3.357 / 3.443 / 944
  net: { lt_m1000: 0.0169, m1000_0: 0.0652, b_0_500: 0.0700, gt_500: 0.0357, no_deposits: 0.0540 },
};

/**
 * Histórico completo (12.922 resueltos, base 7,08%). NO es el default: mezcla
 * el régimen severo de ene-feb 2026 con el actual. Se conserva para poder
 * contrastar cuánto de un score es "el modelo" y cuánto "la época".
 */
export const FULL_HISTORY: Calibration = {
  id: 'full_history@2026-08-24',
  window: 'histórico completo',
  n: 12922,
  baseRejectionRate: 0.0708, // 915 / 12.922
  lambda: 0.8,
  highBandMultiple: 3.5,
  // n = 11.558 / 717 / 235 / 412
  rejections: { r0: 0.0321, r1: 0.2971, r2: 0.4638, r3plus: 0.5388 },
  // CORREGIDO 2026-08-24: mismos tramos invertidos que en RECENT_6M.
  // n = 7.455 / 2.449 / 1.183 / 494 / 1.341
  ratio: { lt_0_5: 0.0420, b_0_5_1: 0.1421, b_1_2: 0.0837, gt_2: 0.1397, no_deposits: 0.0641 },
  // n = 121 / 1.102 / 3.304 / 8.394
  age: { lt_1d: 0.1653, b_1_7d: 0.0980, b_7_30d: 0.0645, gt_30d: 0.0684 },
  // n = 1.180 / 1.691 / 4.445 / 4.265 / 1.341
  net: { lt_m1000: 0.0305, m1000_0: 0.1029, b_0_500: 0.0945, gt_500: 0.0467, no_deposits: 0.0641 },
  // Sin medición propia en la ventana completa: se reusan los de 6 meses, que
  // es la ventana donde la señal se midió. Anotado para no darlo por medido.
  p2p: { staff: 0.0170, none: 0.0390, partial: 0.0835, covers: 0.1162 },
};

export const DEFAULT_CALIBRATION = RECENT_6M;

/**
 * Resuelve el preset que pide el query string. Un valor desconocido cae al
 * default en vez de dar 400: la calibración es una preferencia de análisis, no
 * un parámetro de negocio, y romper la pantalla por un typo no ayuda a nadie.
 */
export function calibrationFromParam(v: string | null | undefined): Calibration {
  if (v === 'full_history') return FULL_HISTORY;
  return DEFAULT_CALIBRATION;
}

// ── Aritmética ───────────────────────────────────────────────────────────────

/** log-odds de aprobación de una tasa de rechazo. Clampeado: r=0 daría ±∞. */
function approvalLogOdds(rejectionRate: number): number {
  const r = Math.min(Math.max(rejectionRate, 0.001), 0.999);
  return Math.log((1 - r) / r);
}

/**
 * Weight of evidence de un tramo: cuánto se aparta del promedio de la ventana.
 * 0 = se comporta como el promedio y no debe mover el score.
 */
function woe(rejectionRate: number, cal: Calibration): number {
  return approvalLogOdds(rejectionRate) - approvalLogOdds(cal.baseRejectionRate);
}

/**
 * Cortes de banda, DERIVADOS de la tasa base en vez de fijos.
 *
 * POR QUÉ NO 60/85 FIJOS: con una base de aprobación de 94,90%, un corte fijo
 * en 85 declararía "riesgo bajo" a un perfil con TRES VECES la tasa de rechazo
 * promedio, y en la ventana histórica (92,92%) el mismo 85 significaría otra
 * cosa distinta. Atando los cortes a la base, la semántica queda estable
 * aunque el criterio del equipo se mueva:
 *
 *   · low    → score > (100 − base):        "no peor que el promedio". 6M: >94,90
 *   · medium → entre los dos cortes:        "peor que el promedio, sin alarma"
 *   · high   → score < (100 − 3,5·base):    "≈1 de cada 5 se rechaza". 6M: <82,15
 *
 * DISTRIBUCIÓN MEDIDA con estos cortes sobre los 9.785 resueltos de la ventana
 * (backtest in-sample), que es la razón por la que quedaron acá:
 *
 *     low     8.221 (84,0% de la cola)   rechazo real  1,76%
 *     medium    921 ( 9,4%)              rechazo real  6,84%
 *     high      643 ( 6,6%)              rechazo real 45,26%   ← 8,9× la base
 *
 * Monótono y con una banda alta chica y densa: revisar a fondo el 6,6% de la
 * cola atrapa casi la mitad de los rechazos. AUC global 0,8626.
 *
 * Que la mayoría de la cola caiga en `low` es correcto y deseado: hoy se
 * aprueba el 95%, y la herramienta existe para levantar la mano sobre los
 * pocos que valen una mirada, no para sembrar dudas sobre todos.
 */
export function bandsFor(cal: Calibration = DEFAULT_CALIBRATION): { low: number; high: number } {
  return {
    low: 100 * (1 - cal.baseRejectionRate),
    high: 100 * (1 - cal.highBandMultiple * cal.baseRejectionRate),
  };
}

function bandOf(score: number, cal: Calibration): RiskBand {
  const { low, high } = bandsFor(cal);
  if (score < high) return 'high';
  if (score < low) return 'medium';
  return 'low';
}

/** Un WoE chico es ruido de redondeo: no merece decirle nada al humano. */
const NEUTRAL_EPS = 0.05;

function impactOf(weight: number): FactorImpact {
  if (weight > NEUTRAL_EPS) return 'up';
  if (weight < -NEUTRAL_EPS) return 'down';
  return 'neutral';
}

const pct = (r: number) => `${(r * 100).toFixed(1).replace('.', ',')}%`;
const money = (n: number) =>
  `US$ ${Math.round(n).toLocaleString('es-AR', { maximumFractionDigits: 0 })}`;

// ── El score ─────────────────────────────────────────────────────────────────

/**
 * Puntúa un retiro. PURO: sin I/O, sin reloj, sin aleatoriedad.
 *
 * Devuelve `approvalScore` 0-100 = probabilidad estimada de APROBACIÓN, la
 * banda de RIESGO y la lista de factores tal como hay que mostrárselos al
 * analista. La suma de `factors[].weight` más el log-odds base ES el
 * `logOdds`: no hay nada escondido.
 */
export function scoreWithdrawal(
  features: WithdrawalFeatures,
  cal: Calibration = DEFAULT_CALIBRATION,
): ScoreResult {
  const base = approvalLogOdds(cal.baseRejectionRate);
  const lambda = cal.lambda;
  const factors: ScoreFactor[] = [];

  // ── 1. Rechazos previos — LA señal. Peso completo, sin amortiguar. ────────
  {
    const r = cal.rejections[features.rejectionBucket];
    const weight = woe(r, cal);
    const n = features.rejectedCountBefore;
    const detail =
      n === 0
        ? `Sin rechazos anteriores → ${pct(r)} de rechazo histórico en este perfil`
        : `${n} rechazo${n === 1 ? '' : 's'} anterior${n === 1 ? '' : 'es'} → ${pct(r)} de rechazo histórico en este perfil`;
    factors.push({ code: 'prior_rejections', label: 'Rechazos previos', impact: impactOf(weight), weight, detail });
  }

  // ── 2. Ratio pedido / depositado ──────────────────────────────────────────
  {
    const r = cal.ratio[features.ratioBucket];
    const weight = lambda * woe(r, cal);
    const detail =
      features.ratioBucket === 'no_deposits'
        ? `Sin depósitos previos: no hay ratio que calcular → ${pct(r)} de rechazo histórico`
        : `Pide ${features.ratio!.toFixed(2).replace('.', ',')}× lo depositado (${money(features.amount)} sobre ${money(features.depositedBefore)}) → ${pct(r)} de rechazo histórico en este tramo`;
    factors.push({ code: 'amount_ratio', label: 'Monto vs. depositado', impact: impactOf(weight), weight, detail });
  }

  // ── 3. Antigüedad de la cuenta al pedir ───────────────────────────────────
  {
    if (features.ageBucket === 'unknown') {
      // Sin fecha de alta no hay evidencia: aporte CERO, no un castigo. Un
      // dato faltante del CRM no es un indicio en contra del cliente.
      factors.push({
        code: 'account_age',
        label: 'Antigüedad de la cuenta',
        impact: 'neutral',
        weight: 0,
        detail: 'El CRM no trae fecha de alta: esta señal no aporta al score',
      });
    } else {
      const r = cal.age[features.ageBucket];
      const weight = lambda * woe(r, cal);
      const days = features.accountAgeDays ?? 0;
      const edad =
        days < 1 ? 'menos de 1 día' : `${Math.floor(days)} día${Math.floor(days) === 1 ? '' : 's'}`;
      factors.push({
        code: 'account_age',
        label: 'Antigüedad de la cuenta',
        impact: impactOf(weight),
        weight,
        detail: `Cuenta de ${edad} al momento de pedir → ${pct(r)} de rechazo histórico en este tramo`,
      });
    }
  }

  // ── 4. Neto real antes de la solicitud ────────────────────────────────────
  {
    const r = cal.net[features.netBucket];
    const weight = lambda * woe(r, cal);
    const detail =
      features.netBucket === 'no_deposits'
        ? `Sin depósitos previos → ${pct(r)} de rechazo histórico`
        : `Neto de ${money(features.netBefore)} (depositó ${money(features.depositedBefore)}, retiró ${money(features.withdrawnBefore)}) → ${pct(r)} de rechazo histórico en este tramo`;
    factors.push({ code: 'net_before', label: 'Neto depositado − retirado', impact: impactOf(weight), weight, detail });
  }

  // ── 5. Origen del dinero ──────────────────────────────────────────────────
  // La señal más fuerte del módulo. Nótese que NO es "retiró más de lo que
  // depositó": eso se midió y no predice (quien retira su ganancia de trading
  // rechaza por DEBAJO de la base). Lo que predice es de dónde vino el dinero.
  {
    const r = cal.p2p[features.p2pBucket];
    const weight = lambda * woe(r, cal);
    const detail =
      features.p2pBucket === 'staff'
        ? `Personal del broker → ${pct(r)} de rechazo histórico. Cobran comisiones, así que retirar sin haber depositado es su forma normal de operar y no se les mide como al resto.`
        : features.p2pBucket === 'none'
          ? `Sin transferencias recibidas de otros usuarios → ${pct(r)} de rechazo histórico`
          : features.p2pBucket === 'covers'
            ? `Recibió ${money(features.p2pReceived)} por transferencias de otros usuarios, suficiente para cubrir este retiro → ${pct(r)} de rechazo histórico`
            : `Recibió ${money(features.p2pReceived)} por transferencias de otros usuarios, menos que este retiro → ${pct(r)} de rechazo histórico`;
    factors.push({ code: 'money_origin', label: 'Origen del dinero', impact: impactOf(weight), weight, detail });
  }

  const logOdds = factors.reduce((acc, f) => acc + f.weight, base);
  const approvalScore = Math.round((100 / (1 + Math.exp(-logOdds))) * 10) / 10;

  return {
    approvalScore,
    band: bandOf(approvalScore, cal),
    factors,
    logOdds,
    calibrationId: cal.id,
  };
}

/**
 * Las tres señales que se MUESTRAN pero NO puntúan. Devuelve el texto para la
 * ficha, siempre con `affectsScore: false`, para que la UI no tenga que
 * recordar la regla ni pueda pintarlas como si fueran factores.
 */
export function informativeNotes(features: WithdrawalFeatures): Array<{
  code: 'kyc' | 'fee_debt' | 'shared_address';
  label: string;
  value: string;
  note: string;
  affectsScore: false;
}> {
  const c = features.context;
  return [
    {
      code: 'kyc',
      label: 'KYC',
      value: c.kycStatus ?? 'sin dato',
      note: 'No afecta el score: los 915 rechazos del histórico son todos de usuarios VERIFIED y los 95 con KYC NONE tienen 0% de rechazo.',
      affectsScore: false,
    },
    {
      code: 'fee_debt',
      label: 'Deuda de comisiones',
      value: money(c.pendingFeeDebt),
      note: 'No afecta el score: 34 casos en todo el histórico, 0 rechazos. Muestra insuficiente.',
      affectsScore: false,
    },
    {
      code: 'shared_address',
      label: 'Dirección de destino',
      value: c.addressShared
        ? `compartida con ${c.sharedAddressUserCount - 1} usuario${c.sharedAddressUserCount - 1 === 1 ? '' : 's'} más`
        : 'exclusiva de este cliente',
      note: 'No afecta el score: las direcciones compartidas se rechazan MENOS (6,18% vs 7,39%) — son exchanges y custodios legítimos, no colusión.',
      affectsScore: false,
    },
  ];
}
