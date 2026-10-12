// ─────────────────────────────────────────────────────────────────────────────
// statusKind — el ÚNICO mapa «estado de dominio → color de badge».
//
// POR QUÉ (2026-10-12, rediseño «Libro mayor», primitivas): el color de un
// estado se decide hoy en cada pantalla, a ojo, eligiendo una variante del
// `Badge` legado (success/warning/danger/neutral). Medido en src/: sólo
// órdenes de pago tiene un mapa propio (components/payment-orders/
// status-badge.tsx, `VARIANT`); negociaciones de RRHH tiene otro local, y el
// resto (egresos, Pay-Pros, frescura de proveedores) escribe la clase en el
// JSX. Es el modo de falla número uno del repo — listas duplicadas que se
// desincronizan en silencio (docs/reglas-del-proyecto.md §1.1) — así que el
// sistema nuevo nace con UN mapa.
//
// Órdenes de pago respeta la decisión ya tomada en `VARIANT`: aprobada = ok,
// igual que pagada, porque la orden aprobada ya autoriza la salida de fondos
// (`isAuthorized()` en payment-orders/types.ts); la etiqueta desambigua.
// Desde la migración de esa pantalla (2026-10-12) `VARIANT` ya no existe:
// components/payment-orders/status-badge.tsx lee de acá (lo fija
// payment-orders/status-badge.test.ts) y anulada pasó a `bad`.
//
// REGLAS (docs/diseno-libro-mayor.md §2.1 y §5.5):
//   ok      = completado / cobrado / pagado / al día        → pos
//   pend    = requiere acción de alguien                    → pend
//   bad     = rechazado / error / no cobrado                → neg
//   info    = paso intermedio que no requiere acción        → info
//   stale   = dato viejo que sigue sumando                  → stale
//   neutral = sin significado de dinero (borrador)
//
// Los mapas están tipados contra los tipos canónicos de cada dominio
// (`Record<PaymentOrderStatus, …>`): si mañana aparece un estado nuevo, `tsc`
// falla acá en vez de caer en silencio al gris. Un estado desconocido en
// runtime (dato viejo en la base) devuelve `neutral` — nunca `ok` — e
// `isKnownStatus` deja que la pantalla lo cuente si le importa.
//
// DESCARTADO:
//   · Un mapa plano `string → kind` sin dominio: «pending» de una orden
//     (espera aprobación) no es el «pendiente» de un egreso (falta pagar), y
//     Pay-Pros distingue «paid» (depósito) de «payout_paid» (retiro). El
//     dominio es parte de la clave.
//   · Poner los labels acá: viven en STATUS_LABELS / i18n. Este archivo decide
//     sólo el color, para no crear una segunda lista de textos.
// ─────────────────────────────────────────────────────────────────────────────
import type { PaymentOrderStatus } from '@/lib/payment-orders/types';
import type { ExpenseStatus } from '@/lib/monthly-close-pdf-data';
import type {
  CoinsbuyDepositTx,
  CoinsbuyWithdrawalTx,
  FairpayDepositTx,
  FetchStatus,
  PayprosTxStatus,
  UnipaymentDepositTx,
} from '@/lib/api-integrations/types';
import type { RiskBand, FactorImpact } from '@/lib/withdrawal-risk/score';
import type { AccountRisk, SignalStatus } from '@/lib/risk/account-review';
import type { NivelToxico } from '@/lib/risk/broker-toxicity';

export type StatusKind = 'ok' | 'pend' | 'bad' | 'info' | 'stale' | 'neutral';

/** Todos los kinds, en el orden de la spec. Para iterar en tests y en la muestra. */
export const STATUS_KINDS: readonly StatusKind[] = ['ok', 'pend', 'bad', 'info', 'stale', 'neutral'];

const PAYMENT_ORDER: Record<PaymentOrderStatus, StatusKind> = {
  draft: 'neutral',
  pending: 'pend', // espera la decisión de Finanzas
  approved: 'ok', // ya autoriza la salida de fondos (isAuthorized) — ver cabecera
  paid: 'ok',
  rejected: 'bad',
  // Anulada = bad (2026-10-12, migración de Órdenes de pago): la orden NO se
  // va a pagar — para quien la esperaba es una noticia de dinero igual que
  // «rechazada», no un estado neutro. Antes 'neutral' (heredado de `VARIANT`).
  cancelled: 'bad',
};

const EXPENSE: Record<ExpenseStatus, StatusKind> = {
  pagado: 'ok',
  pendiente: 'pend',
  parcial: 'pend', // falta pagar una parte: sigue requiriendo acción
};

const PAYPROS: Record<PayprosTxStatus, StatusKind> = {
  paid: 'ok',
  payout_paid: 'ok',
  unpaid: 'pend',
  refund_approved: 'info',
  refund_declined: 'bad',
  payout_declined: 'bad',
};

// Estados de las transacciones de las pasarelas con status en inglés
// (Coinsbuy, FairPay, Unipayment). Agregado 2026-10-12 para el libro de
// movimientos de /movimientos/desglose: antes el desglose tenía su propio
// `StatusBadge` local con una lista ['Confirmed','Approved','Completed','paid']
// pintada de verde y TODO lo demás en gris — un «Rejected» se veía igual que
// un «Pending». Tipado contra la unión de los tipos de cada proveedor: si un
// proveedor suma un estado, `tsc` falla acá.
type ApiTxStatus =
  | CoinsbuyDepositTx['status']
  | CoinsbuyWithdrawalTx['status']
  | FairpayDepositTx['status']
  | UnipaymentDepositTx['status'];

const API_TX: Record<ApiTxStatus, StatusKind> = {
  Confirmed: 'ok',
  Approved: 'ok',
  Completed: 'ok',
  Pending: 'pend', // la plata todavía está en juego
  Failed: 'bad',
  Rejected: 'bad',
  Expired: 'neutral', // terminal, no movió plata ni requiere acción
};

const FETCH: Record<FetchStatus, StatusKind> = {
  fresh: 'ok',
  stale: 'stale',
  error: 'bad',
};

// ── Riesgo ──────────────────────────────────────────────────────────────────
// MUDADOS el 2026-10-12 (barrido final «Libro mayor») desde
// components/risk/risk-kinds.ts, que los escribió con esta misma forma
// «para mudarlos tal cual cuando se pueda» (su tanda tenía `ui/**` vedado).
// Los valores son los mismos, uno por uno: risk-kinds.test.ts los fija y
// además compara cada mapa entero contra la tabla vieja. risk-kinds.ts sigue
// exportando bandKind/withdrawalStatusKind/… y ahora delega acá. El porqué
// de cada valor está en la cabecera de risk-kinds.ts.

/** Banda de RIESGO del score (alta banda = score bajo). */
const RISK_BAND: Record<RiskBand, StatusKind> = {
  low: 'ok',
  medium: 'pend',
  high: 'bad',
};

/** `crm_withdrawals.status_norm` (CHECK de la migración 088). `approved` es
 *  COMPLETED: la plata salió. */
type WithdrawalNorm = 'approved' | 'rejected' | 'cancelled' | 'pending' | 'unknown';
const WITHDRAWAL_NORM: Record<WithdrawalNorm, StatusKind> = {
  approved: 'ok',
  rejected: 'bad',
  cancelled: 'neutral', // lo canceló el cliente: no movió plata ni pide acción
  pending: 'pend', // ON_HOLD / REQUESTED / IN_PROCESS: todavía se mueve
  unknown: 'neutral',
};

/** `crm_deposits.status_norm` (CHECK de la migración 088). */
type DepositNorm = 'completed' | 'cancelled' | 'pending' | 'in_review' | 'unknown';
const DEPOSIT_NORM: Record<DepositNorm, StatusKind> = {
  completed: 'ok',
  cancelled: 'neutral',
  pending: 'pend',
  in_review: 'info',
  unknown: 'neutral',
};

/** Decisión registrada por el equipo (withdrawal_reviews.decision). */
type ReviewDecision = 'approve' | 'reject' | 'escalate' | 'pending';
const REVIEW_DECISION: Record<ReviewDecision, StatusKind> = {
  approve: 'ok',
  reject: 'bad',
  escalate: 'pend', // soporte lo subió: finanzas tiene que decidir
  pending: 'neutral',
};

/** Severidad de un factor del score: 'down' empuja a rechazar. */
const RISK_FACTOR: Record<FactorImpact, StatusKind> = {
  down: 'bad',
  up: 'ok',
  neutral: 'neutral',
};

/** Riesgo operativo de una cuenta (account-review) y toxicidad para el bróker. */
const RISK_LEVEL: Record<AccountRisk | NivelToxico, StatusKind> = {
  ok: 'ok',
  medio: 'pend',
  alto: 'bad',
};

/** Estado de una regla/señal. «Sin comprobar» NO es cumplida: `pend`. */
const RISK_CHECK: Record<SignalStatus, StatusKind> = {
  pass: 'ok',
  fail: 'bad',
  unverifiable: 'pend',
};

/** Veredicto del REGLAMENTO de prop firm (no una decisión de nadie). */
export type PropfirmOutcome = 'ok' | 'denied_new_period' | 'denied_no_new_period' | 'cannot_review';
const PROPFIRM_OUTCOME: Record<PropfirmOutcome, StatusKind> = {
  ok: 'ok',
  denied_new_period: 'pend',
  denied_no_new_period: 'bad',
  cannot_review: 'neutral',
};

export const STATUS_DOMAINS = {
  paymentOrder: PAYMENT_ORDER,
  expense: EXPENSE,
  paypros: PAYPROS,
  apiTx: API_TX,
  fetch: FETCH,
  riskBand: RISK_BAND,
  withdrawalNorm: WITHDRAWAL_NORM,
  depositNorm: DEPOSIT_NORM,
  reviewDecision: REVIEW_DECISION,
  riskFactor: RISK_FACTOR,
  riskLevel: RISK_LEVEL,
  riskCheck: RISK_CHECK,
  propfirmOutcome: PROPFIRM_OUTCOME,
} as const;

export type StatusDomain = keyof typeof STATUS_DOMAINS;

export function isKnownStatus(domain: StatusDomain, status: string | null | undefined): boolean {
  if (!status) return false;
  return Object.prototype.hasOwnProperty.call(STATUS_DOMAINS[domain], status);
}

/**
 * Color de un estado de dominio. Desconocido / null → 'neutral' (gris: no
 * afirma nada). Nunca devuelve 'ok' por defecto.
 */
export function statusKind(domain: StatusDomain, status: string | null | undefined): StatusKind {
  if (!status || !isKnownStatus(domain, status)) return 'neutral';
  return (STATUS_DOMAINS[domain] as Record<string, StatusKind>)[status];
}
