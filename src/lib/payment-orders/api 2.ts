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

import { apiFetch } from '@/lib/api-fetch';
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
