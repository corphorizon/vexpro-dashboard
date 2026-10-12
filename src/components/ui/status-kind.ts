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
// (`isAuthorized()` en payment-orders/types.ts); la etiqueta desambigua. Si se
// quiere aprobada = info (spec §5.5: «pos = pagado/completado»), se cambia
// ACÁ y en `VARIANT` a la vez — o mejor, `VARIANT` pasa a leer de acá cuando
// esa pantalla migre (fase 5) y se borra.
//
// REGLAS (docs/diseno-libro-mayor.md §2.1 y §5.5):
//   ok      = completado / cobrado / pagado / al día        → pos
//   pend    = requiere acción de alguien                    → pend
//   bad     = rechazado / error / no cobrado                → neg
//   info    = paso intermedio que no requiere acción        → info
//   stale   = dato viejo que sigue sumando                  → stale
//   neutral = terminal sin significado de dinero (borrador, anulada)
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
import type { FetchStatus, PayprosTxStatus } from '@/lib/api-integrations/types';

export type StatusKind = 'ok' | 'pend' | 'bad' | 'info' | 'stale' | 'neutral';

/** Todos los kinds, en el orden de la spec. Para iterar en tests y en la muestra. */
export const STATUS_KINDS: readonly StatusKind[] = ['ok', 'pend', 'bad', 'info', 'stale', 'neutral'];

const PAYMENT_ORDER: Record<PaymentOrderStatus, StatusKind> = {
  draft: 'neutral',
  pending: 'pend', // espera la decisión de Finanzas
  approved: 'ok', // ya autoriza la salida de fondos (isAuthorized) — ver cabecera
  paid: 'ok',
  rejected: 'bad',
  cancelled: 'neutral',
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

const FETCH: Record<FetchStatus, StatusKind> = {
  fresh: 'ok',
  stale: 'stale',
  error: 'bad',
};

export const STATUS_DOMAINS = {
  paymentOrder: PAYMENT_ORDER,
  expense: EXPENSE,
  paypros: PAYPROS,
  fetch: FETCH,
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
