// ─────────────────────────────────────────────────────────────────────────────
// timeline — la línea de tiempo de una orden de pago, pura (sin i18n ni DOM).
//
// El historial no es decorativo: es la evidencia de tesorería (quién autorizó
// qué, cuándo y con qué referencia). Por eso vive aparte y con test.
//
// POR QUÉ (2026-10-12, migración «Libro mayor»):
//   · Orden: antes los eventos salían en un orden FIJO (creada, enviada,
//     aprobada, rechazada, pagada, anulada). Una orden rechazada, vuelta a
//     borrador y reenviada mostraba «Enviada» ANTES de «Rechazada» aunque el
//     reenvío fue después — el historial contaba otra historia que la real.
//     Ahora se ordena por la marca de tiempo; el orden lógico sólo desempata
//     (y ubica los eventos sin fecha, que no debería haber).
//   · Actor: `null` cuando la base no lo tiene (usuario borrado, dato viejo).
//     La pantalla dice «un usuario eliminado»; nunca se inventa un nombre.
//     «Enviada» no tiene actor porque la tabla no guarda `submitted_by` — se
//     muestra sin «por …», no con el creador supuesto.
//   · Tono = significado (spec §2.1): creada neutral, enviada pend, aprobada y
//     pagada ok, rechazada y anulada bad — los mismos kinds que el badge
//     (`statusKind('paymentOrder', …)`), así el punto del historial y el badge
//     de la cabecera no pueden contradecirse.
//   · Pasos que faltan: en una orden viva (borrador, pendiente, aprobada) se
//     listan los pasos del camino feliz que todavía no pasaron, en gris
//     («Falta: aprobación»), para que se lea dónde está parada la orden.
//
// DESCARTADO: reconstruir ciclos completos (rechazo → borrador → reenvío)
// con todas sus fechas: la tabla guarda UNA marca por transición (la última),
// así que el historial muestra la última vez que pasó cada cosa. Un log de
// transiciones (tabla de auditoría) es el arreglo de fondo, fuera de esta tanda.
// ─────────────────────────────────────────────────────────────────────────────

import { statusKind, type StatusKind } from '@/components/ui/status-kind';
import type { PaymentOrder, PaymentOrderStatus } from '@/lib/payment-orders/types';

export type TimelineKind = 'created' | 'submitted' | 'approved' | 'rejected' | 'paid' | 'cancelled' | 'expense';

export interface TimelineEvent {
  kind: TimelineKind;
  /** Nombre de quien lo hizo; null = no se sabe (no se inventa). */
  actor: string | null;
  /** ISO de cuándo pasó; null para eventos sin marca (egreso). */
  at: string | null;
  tone: StatusKind;
  /** Motivo de rechazo / anulación. */
  reason?: string;
  /** Referencia de pago (hash, URL del explorer, nº de transferencia). */
  reference?: string;
  /** Aprobada por la misma persona que la creó (aprobación abierta, Kevin 2026-08-05). */
  selfApproved?: boolean;
}

/** Pasos del camino feliz, en orden. Los que faltan se muestran en gris. */
export type UpcomingStep = 'submitted' | 'approved' | 'paid';

const HAPPY_PATH: readonly UpcomingStep[] = ['submitted', 'approved', 'paid'];

/** Desempate / orden lógico para eventos con la misma marca o sin marca. */
const LOGICAL_ORDER: Record<TimelineKind, number> = {
  created: 0,
  submitted: 1,
  rejected: 2,
  approved: 3,
  paid: 4,
  cancelled: 5,
  expense: 6,
};

const toneOf = (s: PaymentOrderStatus): StatusKind => statusKind('paymentOrder', s);

export function buildTimeline(o: PaymentOrder): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  events.push({ kind: 'created', actor: o.created_by_name || null, at: o.created_at || null, tone: 'neutral' });
  if (o.submitted_at) {
    events.push({ kind: 'submitted', actor: null, at: o.submitted_at, tone: toneOf('pending') });
  }
  if (o.approved_at) {
    const self = Boolean(o.approved_by && o.created_by && o.approved_by === o.created_by);
    events.push({
      kind: 'approved',
      actor: o.approved_by_name || null,
      at: o.approved_at,
      tone: toneOf('approved'),
      ...(self ? { selfApproved: true } : {}),
    });
  }
  if (o.rejected_at) {
    events.push({
      kind: 'rejected',
      actor: o.rejected_by_name || null,
      at: o.rejected_at,
      tone: toneOf('rejected'),
      ...(o.rejection_reason ? { reason: o.rejection_reason } : {}),
    });
  }
  if (o.paid_at) {
    events.push({
      kind: 'paid',
      actor: o.paid_by_name || null,
      at: o.paid_at,
      tone: toneOf('paid'),
      ...(o.payment_reference ? { reference: o.payment_reference } : {}),
    });
  }
  if (o.cancelled_at) {
    events.push({
      kind: 'cancelled',
      actor: o.cancelled_by_name || null,
      at: o.cancelled_at,
      tone: toneOf('cancelled'),
      ...(o.cancellation_reason ? { reason: o.cancellation_reason } : {}),
    });
  }
  if (o.expense_id) {
    events.push({ kind: 'expense', actor: null, at: null, tone: 'neutral' });
  }

  const time = (e: TimelineEvent) => {
    const ms = e.at ? Date.parse(e.at) : NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  return events
    .map((e, i) => ({ e, i, ms: time(e) }))
    .sort((a, b) => {
      // Sin fecha: van después de todo lo fechado, en orden lógico.
      if (a.ms == null || b.ms == null) {
        if (a.ms == null && b.ms == null) return LOGICAL_ORDER[a.e.kind] - LOGICAL_ORDER[b.e.kind];
        return a.ms == null ? 1 : -1;
      }
      return a.ms - b.ms || LOGICAL_ORDER[a.e.kind] - LOGICAL_ORDER[b.e.kind] || a.i - b.i;
    })
    .map((x) => x.e);
}

/**
 * Pasos del camino feliz que todavía no pasaron. Vacío en estados terminales
 * (pagada, anulada) y en rechazada: ahí no hay «siguiente paso» que esperar,
 * hay una decisión de volver a borrador o anular.
 */
export function upcomingSteps(status: PaymentOrderStatus): UpcomingStep[] {
  switch (status) {
    case 'draft':
      return [...HAPPY_PATH];
    case 'pending':
      return ['approved', 'paid'];
    case 'approved':
      return ['paid'];
    default:
      return [];
  }
}
