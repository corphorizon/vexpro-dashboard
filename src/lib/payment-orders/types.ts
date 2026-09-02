// ─────────────────────────────────────────────────────────────────────────────
// Órdenes de Pago — contrato compartido (UI, API y generador de PDF).
//
// Espeja supabase/migration-054-payment-orders.sql. Si cambia una, cambia la
// otra: los montos viajan como number (numeric(14,2) en DB) y las fechas como
// 'YYYY-MM-DD' (date) o ISO completo (timestamptz).
// ─────────────────────────────────────────────────────────────────────────────

/** Estados del ciclo de vida. Ver TRANSITIONS para qué puede pasar a qué. */
export type PaymentOrderStatus =
  | 'draft'      // Borrador — editable por quien la creó
  | 'pending'    // Enviada a aprobación — congelada, esperando decisión
  | 'approved'   // Aprobada — inmutable, lista para ejecutar el pago
  | 'paid'       // Pagada — con referencia (txid / referencia bancaria)
  | 'rejected'   // Rechazada por el aprobador, con motivo
  | 'cancelled'; // Anulada (el reemplazo de "editar" una orden ya aprobada)

/** Idioma del documento — independiente del idioma de la UI de quien lo emite. */
export type PaymentOrderLocale = 'es' | 'en';

export type PaymentMethod = 'crypto' | 'bank';

/** Redes sugeridas en el formulario. `crypto_network` acepta texto libre
 *  para el caso "Otra" del documento original. */
export const CRYPTO_NETWORKS = [
  'TRC20 (Tron)',
  'ERC20 (Ethereum)',
  'BEP20 (BSC)',
  'Polygon',
  'Solana',
  'Arbitrum',
] as const;

export interface PaymentOrderLine {
  description: string;
  unitValue: number;
  quantity: number;
  /** unitValue × quantity, redondeado a 2 — se recalcula server-side. */
  amount: number;
}

// ── Archivos adjuntos de una orden ──────────────────────────────────────────
// Dos tipos, dos tablas hijas con la MISMA forma:
//   · comprobantes    → payment_order_proofs      (migración 086)
//   · respaldos       → payment_order_attachments (migración 127)
// Todo lo que sigue —el tope, la fila que ve la UI, el mensaje de "no entra"—
// vive acá y en ningún otro lado.

/**
 * Tope de archivos por orden y por tipo (pedido de Kevin: "hasta 10 archivos",
 * 2026-09-02). Antes eran 5 comprobantes; sube a 10 junto con los respaldos.
 *
 * UN SOLO TOPE PARA LOS DOS: dos números distintos obligan al usuario a
 * recordar cuál rige dónde y a nosotros a explicar "¿por qué acá 5 y allá 10?".
 * Las constantes quedan separadas por nombre (son reglas distintas y mañana
 * pueden divergir), pero hoy salen del mismo valor.
 *
 * ÚNICA fuente de verdad: las usan el endpoint (autoridad real) y la UI (para
 * deshabilitar el botón y avisar antes de subir). Un "10" suelto en dos
 * archivos es la forma más segura de que un día el cliente permita 10 y el
 * servidor 5.
 */
export const MAX_PAYMENT_PROOFS = 10;

/** Tope de documentos de respaldo por orden. Ver MAX_PAYMENT_PROOFS. */
export const MAX_PAYMENT_ATTACHMENTS = 10;

/** Fila de payment_order_proofs tal como la ve la UI (sin el storage_path: el
 *  path del bucket nunca sale del servidor). */
export interface PaymentOrderProof {
  id: string;
  file_name: string | null;
  mime: string | null;
  size: number | null;
  uploaded_at: string;
}

/** Fila de payment_order_attachments tal como la ve la UI. Misma forma que
 *  PaymentOrderProof a propósito: el mismo componente muestra las dos listas. */
export type PaymentOrderAttachment = PaymentOrderProof;

/**
 * Id sintético del respaldo LEGADO — el que todavía vive en las cinco columnas
 * attachment_* de payment_orders porque la migración 127 no corrió (o el
 * backfill no lo alcanzó).
 *
 * Existe para que la UI y el endpoint traten a ese archivo como a cualquier
 * otro de la lista (verlo, descargarlo, quitarlo) sin una segunda rama de
 * "orden vieja" en cada componente. Nunca es un uuid, así que no puede
 * colisionar con un id real.
 */
export const LEGACY_ATTACHMENT_ID = 'legacy';

/**
 * ¿Entran `incoming` archivos nuevos sobre `existing` ya guardados?
 *
 * Pura a propósito: es la regla que el servidor tiene que aplicar sí o sí y la
 * UI quiere anticipar, así que se testea sin Supabase ni DOM. Devuelve el
 * mensaje en castellano (mostrable tal cual) o null si entra.
 *
 * El recorte NUNCA es silencioso: el mensaje dice cuántos hay, cuántos entran
 * todavía y cuál es el máximo (regla del repo — un recorte que no se avisa es
 * indistinguible de "no hay más").
 */
function countError(
  existing: number,
  incoming: number,
  max: number,
  singular: string,
  plural: string,
): string | null {
  if (incoming <= 0) return 'No se recibió ningún archivo.';
  if (existing + incoming > max) {
    const libres = Math.max(0, max - existing);
    return libres === 0
      ? `La orden ya tiene ${max} ${plural} (el máximo). Quitá alguno antes de subir otro.`
      : `La orden ya tiene ${existing} ${existing === 1 ? singular : plural}: solo se pueden agregar ${libres} más (máximo ${max}).`;
  }
  return null;
}

export function proofCountError(existing: number, incoming: number): string | null {
  return countError(existing, incoming, MAX_PAYMENT_PROOFS, 'comprobante', 'comprobantes');
}

export function attachmentCountError(existing: number, incoming: number): string | null {
  return countError(
    existing,
    incoming,
    MAX_PAYMENT_ATTACHMENTS,
    'documento de respaldo',
    'documentos de respaldo',
  );
}

export interface PaymentOrder {
  id: string;
  company_id: string;
  order_number: string;          // OP-2026-0001
  status: PaymentOrderStatus;
  locale: PaymentOrderLocale;

  issue_date: string;            // YYYY-MM-DD
  payment_date: string | null;

  beneficiary_id: string | null;
  beneficiary_name: string;
  beneficiary_tax_id: string | null;
  beneficiary_email: string | null;
  beneficiary_country: string | null;

  lines: PaymentOrderLine[];
  currency: string;
  subtotal: number;
  fees: number;
  total: number;

  payment_method: PaymentMethod;
  crypto_network: string | null;
  crypto_wallet: string | null;
  crypto_memo: string | null;
  bank_name: string | null;
  bank_account_holder: string | null;
  bank_account_number: string | null;
  bank_swift: string | null;
  bank_account_type: string | null;

  notes: string | null;

  // Trazabilidad — los *_name están desnormalizados a propósito para que el
  // PDF histórico no cambie si el usuario se renombra o se da de baja.
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  submitted_at: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_by_name: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  paid_at: string | null;
  paid_by: string | null;
  paid_by_name: string | null;
  payment_reference: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancelled_by_name: string | null;
  cancellation_reason: string | null;

  // Comprobantes de pago — OPCIONALES, hasta MAX_PAYMENT_PROOFS. Respaldo del
  // pago (captura de la transferencia, PDF del banco…) que acompaña a
  // payment_reference. Viven en la tabla payment_order_proofs (migración 086);
  // el archivo está en el bucket PRIVADO `payment-proofs` y la lectura pasa por
  // /api/admin/payment-orders/[id]/proof?proof_id=…, que valida sesión +
  // empresa y emite una URL firmada de corta vida.
  //
  // Opcional en el tipo porque no todas las respuestas lo traen (el listado no
  // hace el join); el detalle y las respuestas de /proof sí.
  proofs?: PaymentOrderProof[];

  // LEGADO (migración 086) — el comprobante único de antes. Se conserva para
  // que un rollback del código siga funcionando; NO leer de acá en código
  // nuevo: si la orden tiene filas en payment_order_proofs, esas mandan.
  payment_proof_path: string | null;
  payment_proof_name: string | null;
  payment_proof_mime: string | null;
  payment_proof_size: number | null;
  payment_proof_uploaded_at: string | null;

  // Documentos de respaldo — OPCIONALES, hasta MAX_PAYMENT_ATTACHMENTS, y
  // DISTINTOS del comprobante de arriba: acá va lo que JUSTIFICA la orden
  // (factura del proveedor, contrato, cotización), no la prueba de que el pago
  // se hizo. Viven en la tabla payment_order_attachments (migración 127); el
  // archivo está en el bucket PRIVADO `payment-attachments` y la lectura pasa
  // por /api/admin/payment-orders/[id]/attachment?attachment_id=…, que valida
  // sesión + empresa y emite una URL firmada de corta vida.
  //
  // Opcional en el tipo porque no todas las respuestas lo traen (el listado no
  // hace el join); el detalle y las respuestas de /attachment sí.
  attachments?: PaymentOrderAttachment[];

  // LEGADO (migración 127) — el respaldo único de antes. Se conserva para que
  // un rollback del código siga funcionando; NO leer de acá en código nuevo: si
  // la orden tiene filas en payment_order_attachments, esas mandan.
  attachment_path: string | null;
  attachment_name: string | null;
  attachment_mime: string | null;
  attachment_size: number | null;
  attachment_uploaded_at: string | null;

  expense_id: string | null;
  updated_at: string;
}

export interface PaymentBeneficiary {
  id: string;
  company_id: string;
  name: string;
  tax_id: string | null;
  email: string | null;
  country: string | null;
  default_payment_method: PaymentMethod | null;
  crypto_network: string | null;
  crypto_wallet: string | null;
  crypto_memo: string | null;
  bank_name: string | null;
  bank_account_holder: string | null;
  bank_account_number: string | null;
  bank_swift: string | null;
  bank_account_type: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Payload de creación/edición (solo en draft). El correlativo, los totales y
 *  todo el bloque de auditoría los resuelve el servidor. */
export interface PaymentOrderInput {
  locale: PaymentOrderLocale;
  issue_date: string;
  payment_date?: string | null;
  beneficiary_id?: string | null;
  beneficiary_name: string;
  beneficiary_tax_id?: string | null;
  beneficiary_email?: string | null;
  beneficiary_country?: string | null;
  lines: PaymentOrderLine[];
  currency: string;
  fees?: number;
  payment_method: PaymentMethod;
  crypto_network?: string | null;
  crypto_wallet?: string | null;
  crypto_memo?: string | null;
  bank_name?: string | null;
  bank_account_holder?: string | null;
  bank_account_number?: string | null;
  bank_swift?: string | null;
  bank_account_type?: string | null;
  notes?: string | null;
  /** Guardar/actualizar el beneficiario en la libreta con estos datos. */
  save_beneficiary?: boolean;
}

// ── Máquina de estados ──────────────────────────────────────────────────────
// Única fuente de verdad de las transiciones válidas: la usan el endpoint
// (autoridad) y la UI (para saber qué botones mostrar).

export const TRANSITIONS: Record<PaymentOrderStatus, PaymentOrderStatus[]> = {
  draft:     ['pending', 'cancelled'],
  pending:   ['approved', 'rejected', 'draft', 'cancelled'],
  approved:  ['paid', 'cancelled'],
  paid:      [],          // terminal
  rejected:  ['draft', 'cancelled'],
  cancelled: [],          // terminal
};

export function canTransition(from: PaymentOrderStatus, to: PaymentOrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Solo los borradores (y los rechazados, que vuelven a borrador) se editan. */
export function isEditable(status: PaymentOrderStatus): boolean {
  return status === 'draft' || status === 'rejected';
}

/** Estados en los que el documento ya vale como autorización formal y el PDF
 *  lleva el sello de aprobación. */
export function isAuthorized(status: PaymentOrderStatus): boolean {
  return status === 'approved' || status === 'paid';
}

export const STATUS_LABELS: Record<PaymentOrderLocale, Record<PaymentOrderStatus, string>> = {
  es: {
    draft: 'Borrador',
    pending: 'Pendiente de aprobación',
    approved: 'Aprobada',
    paid: 'Pagada',
    rejected: 'Rechazada',
    cancelled: 'Anulada',
  },
  en: {
    draft: 'Draft',
    pending: 'Pending approval',
    approved: 'Approved',
    paid: 'Paid',
    rejected: 'Rejected',
    cancelled: 'Void',
  },
};

// ── Cálculo de totales ──────────────────────────────────────────────────────
// Se recalcula SIEMPRE en el servidor a partir de las líneas: el cliente nunca
// es autoridad sobre un monto. La UI usa la misma función para el preview en
// vivo, así lo que se ve es exactamente lo que se guarda.

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export function computeLineAmount(line: Pick<PaymentOrderLine, 'unitValue' | 'quantity'>): number {
  return round2((Number(line.unitValue) || 0) * (Number(line.quantity) || 0));
}

export function computeTotals(lines: PaymentOrderLine[], fees = 0): {
  lines: PaymentOrderLine[];
  subtotal: number;
  fees: number;
  total: number;
} {
  const normalized = lines.map((l) => ({
    description: (l.description ?? '').trim(),
    unitValue: round2(l.unitValue),
    quantity: Number(l.quantity) || 0,
    amount: computeLineAmount(l),
  }));
  const subtotal = round2(normalized.reduce((s, l) => s + l.amount, 0));
  const f = round2(fees);
  return { lines: normalized, subtotal, fees: f, total: round2(subtotal + f) };
}
