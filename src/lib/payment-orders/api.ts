// ─────────────────────────────────────────────────────────────────────────────
// Órdenes de Pago — helpers de CLIENTE.
//
// Mismo patrón que el postData de src/lib/supabase/mutations.ts: apiFetch (que
// ya agrega ?company_id en modo superadmin viewing-as, el timeout y el
// Content-Type), y si la respuesta no es ok se tira el mensaje del servidor —
// que ya viene en castellano y es mostrable al usuario tal cual.
//
// Todo lo tipa el contrato de ./types.ts: la UI no debería declarar formas
// propias de estos objetos.
// ─────────────────────────────────────────────────────────────────────────────

import { apiFetch, withActiveCompany } from '@/lib/api-fetch';
import type {
  PaymentBeneficiary,
  PaymentOrder,
  PaymentOrderInput,
  PaymentOrderStatus,
} from './types';

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error || `Error en la operación (${res.status})`);
  }
  return data as T;
}

const jsonBody = (payload: unknown) => JSON.stringify(payload);

// ── Órdenes ─────────────────────────────────────────────────────────────────

/** Listado de la empresa, opcionalmente filtrado por estado(s). */
export async function listPaymentOrders(opts?: {
  status?: PaymentOrderStatus | PaymentOrderStatus[];
  limit?: number;
}): Promise<PaymentOrder[]> {
  const params = new URLSearchParams();
  if (opts?.status) {
    const list = Array.isArray(opts.status) ? opts.status : [opts.status];
    if (list.length) params.set('status', list.join(','));
  }
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const { orders } = await request<{ orders: PaymentOrder[] }>(
    `/api/admin/payment-orders${qs ? `?${qs}` : ''}`,
  );
  return orders ?? [];
}

export async function getPaymentOrder(id: string): Promise<PaymentOrder> {
  const { order } = await request<{ order: PaymentOrder }>(`/api/admin/payment-orders/${id}`);
  return order;
}

/** Alta de un borrador. El correlativo y los totales los pone el servidor. */
export async function createPaymentOrder(input: PaymentOrderInput): Promise<PaymentOrder> {
  const { order } = await request<{ order: PaymentOrder }>('/api/admin/payment-orders', {
    method: 'POST',
    body: jsonBody(input),
  });
  return order;
}

/** Edición — el servidor la rechaza si la orden no está en draft/rejected. */
export async function updatePaymentOrder(
  id: string,
  input: PaymentOrderInput,
): Promise<PaymentOrder> {
  const { order } = await request<{ order: PaymentOrder }>(`/api/admin/payment-orders/${id}`, {
    method: 'PATCH',
    body: jsonBody(input),
  });
  return order;
}

/** Solo borradores. Una orden ya enviada se anula (transición → cancelled). */
export async function deletePaymentOrder(id: string): Promise<void> {
  await request<{ success: boolean }>(`/api/admin/payment-orders/${id}`, { method: 'DELETE' });
}

export interface TransitionOptions {
  /** Obligatorio para 'rejected'; opcional (pero recomendable) para 'cancelled'. */
  reason?: string;
  /** Obligatorio para 'paid': txid de la blockchain o referencia bancaria. */
  payment_reference?: string;
  /** YYYY-MM-DD. Si no se manda al pagar, el servidor usa la fecha de hoy. */
  payment_date?: string;
  /** Al pagar: generar el egreso en el período abierto. */
  create_expense?: boolean;
  /** Categoría del egreso generado al pagar (opcional). */
  expense_category?: string | null;
}

/**
 * Cambia el estado de la orden. `warning` viene con texto cuando la transición
 * se aplicó pero algo secundario no (ej.: pagada sin período abierto donde
 * registrar el egreso) — mostralo, no lo trates como error.
 */
export async function transitionPaymentOrder(
  id: string,
  to: PaymentOrderStatus,
  opts: TransitionOptions = {},
): Promise<{ order: PaymentOrder; warning: string | null }> {
  const { order, warning } = await request<{ order: PaymentOrder; warning: string | null }>(
    `/api/admin/payment-orders/${id}/transition`,
    { method: 'POST', body: jsonBody({ to, ...opts }) },
  );
  return { order, warning: warning ?? null };
}

// ── Comprobante de pago (opcional) ──────────────────────────────────────────

/**
 * Sube (o reemplaza) el comprobante de la orden. PDF/PNG/JPG/WEBP, máx 10 MB —
 * el servidor valida los magic bytes, no la extensión.
 *
 * OJO: no se setea Content-Type a mano. apiFetch solo lo agrega cuando el body
 * es string, así que con FormData el browser pone el multipart con su boundary
 * (fijarlo a mano rompe el parseo server-side).
 */
export async function uploadPaymentProof(orderId: string, file: File): Promise<PaymentOrder> {
  const body = new FormData();
  body.append('file', file);
  const { order } = await request<{ order: PaymentOrder }>(
    `/api/admin/payment-orders/${orderId}/proof`,
    { method: 'POST', body },
  );
  return order;
}

/** Quita el comprobante (archivo + columnas). No permitido en órdenes anuladas. */
export async function deletePaymentProof(orderId: string): Promise<PaymentOrder> {
  const { order } = await request<{ order: PaymentOrder }>(
    `/api/admin/payment-orders/${orderId}/proof`,
    { method: 'DELETE' },
  );
  return order;
}

/**
 * URL de lectura del comprobante para un <a href> / window.open: el GET
 * responde un 302 a una URL firmada de 10 minutos. Pasa por withActiveCompany
 * porque una navegación directa no atraviesa apiFetch (el superadmin en modo
 * "viendo como" necesita el ?company_id en la URL).
 */
export function paymentProofUrl(orderId: string): string {
  return withActiveCompany(`/api/admin/payment-orders/${orderId}/proof`);
}

// ── Documento de respaldo (opcional) ────────────────────────────────────────
// OJO: es OTRO adjunto, no el comprobante de arriba. Acá va la factura, el
// contrato o la cotización que justifica la orden; el comprobante es la prueba
// del pago ya hecho. Endpoints y buckets separados a propósito.

/**
 * Sube (o reemplaza) el documento de respaldo. PDF/PNG/JPG/WEBP/DOCX/XLSX, máx
 * 10 MB — el servidor valida los magic bytes, no la extensión.
 *
 * OJO: no se setea Content-Type a mano. apiFetch solo lo agrega cuando el body
 * es string, así que con FormData el browser pone el multipart con su boundary
 * (fijarlo a mano rompe el parseo server-side).
 */
export async function uploadOrderAttachment(orderId: string, file: File): Promise<PaymentOrder> {
  const body = new FormData();
  body.append('file', file);
  const { order } = await request<{ order: PaymentOrder }>(
    `/api/admin/payment-orders/${orderId}/attachment`,
    { method: 'POST', body },
  );
  return order;
}

/** Quita el documento (archivo + columnas). No permitido en órdenes anuladas. */
export async function deleteOrderAttachment(orderId: string): Promise<PaymentOrder> {
  const { order } = await request<{ order: PaymentOrder }>(
    `/api/admin/payment-orders/${orderId}/attachment`,
    { method: 'DELETE' },
  );
  return order;
}

/**
 * URL de lectura del documento para un <a href> / window.open: el GET responde
 * un 302 a una URL firmada de 10 minutos. Pasa por withActiveCompany porque una
 * navegación directa no atraviesa apiFetch (el superadmin en modo "viendo como"
 * necesita el ?company_id en la URL).
 */
export function orderAttachmentUrl(orderId: string): string {
  return withActiveCompany(`/api/admin/payment-orders/${orderId}/attachment`);
}

// ── Conceptos ya facturados a un beneficiario ───────────────────────────────

export interface LineSuggestion {
  description: string;
  lastUnitValue: number | null;
}

/**
 * Conceptos usados antes con este beneficiario, del más reciente al más
 * viejo. Se pasa id Y nombre porque las órdenes anteriores a la libreta no
 * tienen beneficiary_id: sin el nombre no sugerirían nada.
 */
export async function listLineSuggestions(params: {
  beneficiaryId?: string | null;
  name?: string | null;
}): Promise<LineSuggestion[]> {
  const qs = new URLSearchParams();
  if (params.beneficiaryId) qs.set('beneficiary_id', params.beneficiaryId);
  if (params.name?.trim()) qs.set('name', params.name.trim());
  if (![...qs.keys()].length) return [];
  const { suggestions } = await request<{ suggestions: LineSuggestion[] }>(
    `/api/admin/payment-orders/line-suggestions?${qs.toString()}`,
  );
  return suggestions ?? [];
}

// ── Libreta de beneficiarios ────────────────────────────────────────────────

export async function listBeneficiaries(q?: string): Promise<PaymentBeneficiary[]> {
  const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
  const { beneficiaries } = await request<{ beneficiaries: PaymentBeneficiary[] }>(
    `/api/admin/payment-beneficiaries${qs}`,
  );
  return beneficiaries ?? [];
}

/** Payload de la libreta — todo opcional salvo el nombre (clave del upsert). */
export type BeneficiaryInput = Partial<
  Omit<PaymentBeneficiary, 'id' | 'company_id' | 'created_at' | 'updated_at' | 'name'>
> & { name: string };

/** Alta o actualización por nombre (case-insensitive) dentro de la empresa. */
export async function saveBeneficiary(input: BeneficiaryInput): Promise<PaymentBeneficiary> {
  const { beneficiary } = await request<{ beneficiary: PaymentBeneficiary }>(
    '/api/admin/payment-beneficiaries',
    { method: 'POST', body: jsonBody(input) },
  );
  return beneficiary;
}
