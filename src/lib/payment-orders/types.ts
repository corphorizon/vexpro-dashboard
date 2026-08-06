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

  // Comprobante de pago — OPCIONAL. Respaldo del pago (captura de la
  // transferencia, PDF del banco…) que acompaña a payment_reference. Se guarda
  // el PATH dentro del bucket privado `payment-proofs`, nunca una URL pública:
  // la lectura pasa por /api/admin/payment-orders/[id]/proof, que valida
  // sesión + empresa y emite una URL firmada de corta vida.
  payment_proof_path: string | null;
  payment_proof_name: string | null;
  payment_proof_mime: string | null;
  payment_proof_size: number | null;
  payment_proof_uploaded_at: string | null;

  // Documento de respaldo — OPCIONAL y DISTINTO del comprobante de arriba:
  // acá va lo que JUSTIFICA la orden (factura del proveedor, contrato,
  // cotización), no la prueba de que el pago se hizo. Se guarda el PATH dentro
  // del bucket privado `payment-attachments`: la lectura pasa por
  // /api/admin/payment-orders/[id]/attachment, que valida sesión + empresa y
  // emite una URL firmada de corta vida.
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
