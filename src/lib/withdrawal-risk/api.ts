// ─────────────────────────────────────────────────────────────────────────────
// Cliente tipado del módulo de Revisión de Retiros.
//
// Todo pasa por `apiFetch` y no por `fetch` pelado: apiFetch agrega el
// `company_id` cuando un superadmin está viendo otra empresa, pone el timeout
// y el Content-Type. Llamar a fetch directo rompe el "ver como".
//
// Los tipos entran con `import type` a propósito. `query.ts` es código de
// servidor (habla con Supabase); si algo de acá lo importara en valor, el
// cliente se llevaría media base de datos al bundle. Con `import type` el
// import se borra en compilación y no queda rastro.
// ─────────────────────────────────────────────────────────────────────────────

import { apiFetch } from '@/lib/api-fetch';
import type {
  QueueItem,
  WithdrawalDetail,
  QueueFilters,
  ResolvedItem,
} from '@/lib/withdrawal-risk/query';
import type { RiskBand } from '@/lib/withdrawal-risk/score';
// Mismo criterio de `import type`: account-review-read.ts es código de
// servidor (habla con Supabase y con MT5).
import type { AccountsOverview } from '@/lib/risk/account-review-read';

export type { QueueItem, WithdrawalDetail, QueueFilters, ResolvedItem, RiskBand };

/** Datos de la calibración vigente, para poder explicar de dónde sale el score. */
export interface CalibrationInfo {
  id: string;
  window: string;
  n: number;
  baseRejectionRate: number;
  bands: { low: number; high: number };
}

export interface QueueResponse {
  /** Solicitados y sin tocar: los que esperan una primera decisión. */
  items: QueueItem[];
  /** Listas que llegaron a su tope y por lo tanto están recortadas. */
  truncated: { instant: boolean; resolved: boolean };
  /** Instantáneos: ya cobrados, van siempre aparte. */
  instant: QueueItem[];
  /** Cambiaron de estado (cerrados, o abiertos pero ya tocados). */
  resolved: ResolvedItem[];
  totalPending: number;
  counts: Record<RiskBand, number>;
  calibration: CalibrationInfo;
  disclaimer: string;
}

export interface DetailResponse {
  detail: WithdrawalDetail;
  /**
   * Diagnóstico operativo de las cuentas del cliente. `null` cuando el cálculo
   * falló — la ficha se sirve igual, porque el score y la decisión no dependen
   * de esto. Es una señal APARTE, no una corrección del score.
   */
  accounts: AccountsOverview | null;
  calibration: CalibrationInfo;
  disclaimer: string;
}

export type Decision = 'approve' | 'reject' | 'escalate' | 'pending';

export interface DecisionResponse {
  review: {
    withdrawal_external_id: string;
    score: number | null;
    score_band: RiskBand | null;
    decision: string | null;
    decided_by_name: string | null;
    decided_at: string | null;
    notes: string | null;
  };
  /** Siempre false: el dashboard es solo-lectura sobre el CRM. */
  executedInCrm: boolean;
  message: string;
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `Error en la operación (${res.status})`);
  }
  return data as T;
}

/**
 * Filtros de la cola. Van al SERVIDOR y no se filtra en memoria: a diferencia
 * de las órdenes de pago (decenas de filas), acá el histórico son decenas de
 * miles y el score se calcula por fila. Traer todo para descartar en el
 * navegador sería tirar trabajo del servidor a la basura.
 */
export function queueQueryString(filters: QueueFilters & { calibration?: string | null }): string {
  const p = new URLSearchParams();
  const put = (k: string, v: unknown) => {
    if (v === null || v === undefined || v === '') return;
    p.set(k, String(v));
  };
  put('minAmount', filters.minAmount);
  put('maxAmount', filters.maxAmount);
  put('band', filters.band);
  put('processor', filters.processor);
  put('coin', filters.coin);
  put('olderThanDays', filters.olderThanDays);
  put('q', filters.q);
  put('from', filters.from);
  put('to', filters.to);
  put('calibration', filters.calibration);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function loadQueue(
  filters: QueueFilters & { calibration?: string | null } = {},
): Promise<QueueResponse> {
  return request<QueueResponse>(`/api/admin/withdrawal-review${queueQueryString(filters)}`);
}

export function loadDetail(externalId: string, calibration?: string | null): Promise<DetailResponse> {
  const q = calibration ? `?calibration=${encodeURIComponent(calibration)}` : '';
  return request<DetailResponse>(`/api/admin/withdrawal-review/${encodeURIComponent(externalId)}${q}`);
}

export function saveDecision(
  externalId: string,
  body: { decision: Decision; notes?: string | null; calibration?: string | null },
): Promise<DecisionResponse> {
  return request<DecisionResponse>(`/api/admin/withdrawal-review/${encodeURIComponent(externalId)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
