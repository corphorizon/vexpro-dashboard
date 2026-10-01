// ─────────────────────────────────────────────────────────────────────────────
// Órdenes de Pago — ELIMINACIÓN DEFINITIVA: lógica pura y contrato de respuesta.
//
// Pedido del dueño (2026-10-01, con captura de /ordenes-pago): «agreguemos la
// forma de poder eliminar una orden de pago si se debe, y que se elimine de los
// egresos también, porque esa pega allá también». Hasta acá solo se podía
// borrar un BORRADOR; lo emitido se ANULABA (soft, deja la fila). Una orden
// PAGADA además genera un egreso (expenses.payment_order_id) que, al borrar la
// orden, quedaría huérfano.
//
// El endpoint (DELETE /api/admin/payment-orders/[id]) hace la parte con DB y
// Storage. Acá vive lo que se puede decidir sin Supabase —qué archivos borrar,
// cómo contar lo que no se pudo, qué confirmación pide la UI, qué queda en el
// audit— para poder testearlo: el endpoint no tiene harness de tests y su red
// de seguridad es justamente que TODO lo que hace vuelve contado en la
// respuesta y en el audit (nada silencioso).
//
// Client-safe: no importa el admin client. La UI usa deleteConfirmKind() y el
// tipo DeletedOrderSummary.
// ─────────────────────────────────────────────────────────────────────────────

import type { PaymentOrder, PaymentOrderStatus } from './types';

// ── Contrato de la respuesta ────────────────────────────────────────────────

/** Egreso que se borró junto con la orden. */
export interface DeletedExpenseSummary {
  id: string;
  amount: number;
  concept: string | null;
  period_id: string | null;
}

/**
 * Desglose de un borrado definitivo. Viaja en la respuesta del DELETE y es lo
 * que la UI muestra en el toast: el usuario ve QUÉ se fue, no un "listo".
 */
export interface DeletedOrderSummary {
  orden: {
    id: string;
    order_number: string;
    beneficiary_name: string;
    total: number;
    currency: string;
    /** Estado en el que estaba al borrarla. */
    status: PaymentOrderStatus;
  };
  /**
   * Egresos borrados. Normalmente 0 (no pagada, o pagada sin egreso) o 1: el
   * índice único de la migración 079 impide dos por payment_order_id. Es un
   * array porque también se sigue el puntero inverso payment_orders.expense_id
   * (órdenes previas a la 058 cuyo egreso nunca tuvo payment_order_id), y si
   * los dos caminos llegaran a filas distintas se borran y se informan ambas.
   */
  egresosBorrados: DeletedExpenseSummary[];
  /** Filas de archivos que se fueron con la orden (cascade de las FKs). */
  adjuntosBorrados: { comprobantes: number; respaldos: number };
  /** Objetos borrados de Storage. */
  archivosBorrados: number;
  /**
   * Objetos que NO se pudieron borrar de Storage (o que ya no estaban). No
   * abortan el borrado contable —la plata manda—, pero se cuentan y se
   * loguean: un archivo huérfano en el bucket es basura, no un número falso.
   */
  archivosFallidos: number;
  /**
   * Comprobantes que se dejaron en el bucket a propósito porque OTRO egreso
   * (no el borrado) todavía los referencia en attachment_path. Borrarlos le
   * rompería el adjunto a esa fila sin que nada falle.
   */
  archivosPreservados: number;
}

// ── Qué confirmación pide la UI ─────────────────────────────────────────────

/**
 * 'paid'   → el confirm nombra el egreso vinculado: borrarla toca Egresos.
 * 'simple' → borrador / pendiente / aprobada / rechazada / anulada: ninguna
 *            de esas genera egreso (solo 'paid' lo hace, y es terminal).
 *
 * expense_id también cuenta: si por algún camino una orden no pagada tuviera
 * un egreso apuntado, el aviso fuerte es el que corresponde.
 */
export type DeleteConfirmKind = 'paid' | 'simple';

export function deleteConfirmKind(
  order: Pick<PaymentOrder, 'status' | 'expense_id'>,
): DeleteConfirmKind {
  return order.status === 'paid' || !!order.expense_id ? 'paid' : 'simple';
}

// ── Qué archivos borrar ─────────────────────────────────────────────────────

export interface OrderStorageSources {
  /** payment_order_proofs.storage_path (migración 086). */
  proofPaths: (string | null | undefined)[];
  /** payment_order_attachments.storage_path (migración 127). */
  attachmentPaths: (string | null | undefined)[];
  /** payment_orders.payment_proof_path — comprobante LEGADO (pre-086). */
  legacyProofPath?: string | null;
  /** payment_orders.attachment_path — respaldo LEGADO (pre-127). */
  legacyAttachmentPath?: string | null;
}

const uniq = (list: (string | null | undefined)[]): string[] =>
  Array.from(new Set(list.filter((p): p is string => typeof p === 'string' && p.trim() !== '')));

/**
 * Paths a borrar, por bucket, sin duplicados.
 *
 * El path legado se suma SIEMPRE (no solo si no hay filas): el backfill de las
 * migraciones 086/127 copió ese mismo path a una fila, así que normalmente es
 * un duplicado —y el Set lo absorbe—; pero si el backfill no lo alcanzó, es el
 * único rastro del archivo y saltearlo lo dejaría huérfano en el bucket.
 */
export function orderStoragePaths(src: OrderStorageSources): {
  proofs: string[];
  attachments: string[];
} {
  return {
    proofs: uniq([...src.proofPaths, src.legacyProofPath]),
    attachments: uniq([...src.attachmentPaths, src.legacyAttachmentPath]),
  };
}

/**
 * Separa los comprobantes que todavía referencia OTRO egreso.
 *
 * Por qué existe: el egreso de una OP no copia el archivo, apunta al
 * comprobante ORIGINAL en `payment-proofs` (createExpenseForPaidOrder). Ese
 * egreso se borra junto con la orden, pero si quedó otra fila de expenses con
 * el mismo path (p. ej. un egreso de OP que en la era previa a la 079 se
 * re-insertó desde /upload y perdió su payment_order_id), borrar el objeto le
 * dejaría a esa fila un adjunto roto. Se preserva y se cuenta.
 */
export function splitStillReferenced(
  paths: string[],
  referencedElsewhere: Iterable<string | null | undefined>,
): { remove: string[]; keep: string[] } {
  const ref = new Set<string>();
  for (const p of referencedElsewhere) if (p) ref.add(p);
  return {
    remove: paths.filter((p) => !ref.has(p)),
    keep: paths.filter((p) => ref.has(p)),
  };
}

/**
 * Cuántos objetos se borraron y cuántos no, a partir de lo que devuelve
 * storage.remove(): `removedReported` = largo del array de objetos borrados, o
 * null si la llamada falló entera.
 *
 * Storage NO da error por un path inexistente: simplemente no lo incluye en la
 * respuesta. Por eso "fallido" = "pedido y no confirmado", que incluye los que
 * ya no estaban. Es conservador a propósito: preferimos avisar de más a dar
 * por borrado algo que nadie confirmó.
 */
export function storageRemovalOutcome(
  requested: number,
  removedReported: number | null,
): { removed: number; failed: number } {
  if (requested <= 0) return { removed: 0, failed: 0 };
  if (removedReported === null) return { removed: 0, failed: requested };
  const removed = Math.min(Math.max(0, removedReported), requested);
  return { removed, failed: requested - removed };
}

// ── Audit ───────────────────────────────────────────────────────────────────

const money = (n: number, currency: string) =>
  `${currency} ${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;

/**
 * Texto del audit_logs de un borrado definitivo. Es lo ÚNICO que queda cuando
 * ya no hay fila, así que lleva todo: número, beneficiario, total, estado al
 * borrar, egreso(s) con id y monto, y el resultado de los archivos.
 */
export function deleteAuditDetails(
  s: DeletedOrderSummary,
  statusLabel: string,
): string {
  const o = s.orden;
  const parts = [
    `Eliminó DEFINITIVAMENTE la orden de pago ${o.order_number} — ${o.beneficiary_name} — ${money(o.total, o.currency)} — estado al borrar: ${statusLabel}`,
  ];
  if (s.egresosBorrados.length === 0) {
    parts.push('egreso vinculado: no tenía');
  } else {
    for (const e of s.egresosBorrados) {
      parts.push(
        `egreso borrado: id ${e.id}, ${money(e.amount, o.currency)}` +
          (e.concept ? `, "${e.concept}"` : '') +
          (e.period_id ? `, período ${e.period_id}` : ''),
      );
    }
  }
  parts.push(
    `adjuntos: ${s.adjuntosBorrados.comprobantes} comprobante(s) y ${s.adjuntosBorrados.respaldos} respaldo(s)`,
  );
  parts.push(
    `archivos en Storage: ${s.archivosBorrados} borrado(s), ${s.archivosFallidos} sin confirmar` +
      (s.archivosPreservados > 0
        ? `, ${s.archivosPreservados} preservado(s) por estar referenciado(s) por otro egreso`
        : ''),
  );
  return parts.join(' · ');
}
