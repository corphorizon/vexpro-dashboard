// ─────────────────────────────────────────────────────────────────────────────
// Depósitos de Pay-Pros — derivados del CRM, no del webhook.
//
// POR QUÉ NO POR WEBHOOK
// El receptor de webhooks (`/api/webhooks/paypros/[token]`) está construido,
// validando firma y esperando desde el 16 de agosto, y NUNCA recibió un
// evento: la URL que se registró con Pay-Pros es la del CRM
// (srv6754.vexprofx.com), no la nuestra. Pay-Pros les notifica a ellos.
//
// Decisión de Kevin (2026-08-24): en vez de esperar a que alguien agregue una
// segunda URL de notificación, sacamos los depósitos directamente de Orion,
// que ya los tiene y que ya espejamos cada 4 h. Es la fuente que el broker usa
// para atender al cliente, así que es también la que manda contablemente.
//
// CÓMO SE RECONOCEN
// En Orion cada depósito trae `paymentProvider`. Los valores reales son
// UNIPAYMENT (8.682), FAIRPAY (927), PAYPROS (34) y MUWE (22); 29.750 lo
// traen nulo (son anteriores al campo o de otra vía). Filtramos por PAYPROS.
//
// SÓLO LOS COMPLETADOS
// De los 34, hay 18 COMPLETED ($6.956), 14 CANCELLED y 2 IN_REVIEW. Un
// depósito cancelado no es plata que entró: si lo asentáramos, el libro
// diría que tenemos dinero que no existe. Por eso el filtro es estricto y no
// "todo lo que no esté cancelado".
//
// EL RIESGO DE CONTAR DOS VECES
// Si algún día alguien SÍ registra nuestra URL, el webhook escribiría en la
// misma tabla con su propio `uid` como clave, y el mismo depósito entraría
// dos veces por dos caminos distintos. No podemos evitarlo con el índice
// único porque las claves son diferentes. Lo que sí hacemos es que ese choque
// sea RUIDOSO: si aparecen filas de las dos procedencias, se reporta. Un
// descuadre que avisa es infinitamente mejor que uno silencioso.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';

/** Cómo Orion nombra a Pay-Pros en `deposits.paymentProvider`. */
export const CRM_PAYMENT_PROVIDER = 'PAYPROS';

/** El proveedor con el que el libro ya sabe leer Pay-Pros (RPC 085). */
const PROVIDER = 'paypros';

/**
 * Estado con el que se asienta. El RPC `get_channel_day_movements` cuenta
 * `paypros` cuando el status es 'paid' (entrada) o 'payout_paid' (salida).
 * Un depósito siempre es entrada.
 */
const ENTRY_STATUS = 'paid';

/**
 * Prefijo que marca la procedencia. No es decorativo: es lo que permite
 * distinguir estas filas de las que escribiría el webhook y detectar el doble
 * conteo descripto en la cabecera.
 */
export const CRM_ID_PREFIX = 'crm:';

export interface PayprosFromCrmResult {
  /** Depósitos completados encontrados en el espejo. */
  found: number;
  /** Filas escritas o actualizadas en api_transactions. */
  upserted: number;
  /** Suma en USD de lo asentado. */
  totalUsd: number;
  /**
   * Filas de Pay-Pros que NO vienen del CRM (es decir: del webhook). Si esto
   * es > 0 hay dos fuentes vivas y el canal puede estar contando doble.
   */
  webhookRows: number;
  warnings: string[];
}

export interface CrmDepositRow {
  external_id: string;
  amount_paid: number | null;
  coin: string | null;
  deposit_at: string | null;
  external_payment_id: string | null;
  status_raw: string | null;
  user_external_id: string | null;
}

/**
 * Separa los depósitos que se pueden asentar de los que no, avisando por cada
 * descarte. Es pura para poder fijarla con tests: acá se decide qué entra al
 * libro, y una regla equivocada mueve plata que no existe.
 *
 * Un depósito sin fecha no se puede asentar en NINGÚN día, y uno sin importe
 * no es un movimiento. Ninguno de los dos se descarta en silencio.
 */
export function selectUsableDeposits(rows: CrmDepositRow[]): {
  usable: CrmDepositRow[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const usable = rows.filter((r) => {
    if (!r.deposit_at) {
      warnings.push(`Depósito ${r.external_id} sin fecha: no se puede asentar.`);
      return false;
    }
    if (!r.amount_paid || r.amount_paid <= 0) {
      warnings.push(`Depósito ${r.external_id} sin importe (${r.amount_paid}): se omite.`);
      return false;
    }
    return true;
  });
  return { usable, warnings };
}

/**
 * Proyecta los depósitos Pay-Pros del espejo del CRM a `api_transactions`,
 * que es de donde el libro del canal saca los movimientos del día.
 *
 * Es idempotente: la clave `(company_id, provider, external_id)` tiene índice
 * único y el id del depósito en Orion no cambia, así que correrlo seis veces
 * al día no duplica nada.
 */
export async function syncPayprosDepositsFromCrm(
  admin: SupabaseClient,
  companyId: string,
): Promise<PayprosFromCrmResult> {
  const warnings: string[] = [];

  const { data, error } = await admin
    .from('crm_deposits')
    .select('external_id, amount_paid, coin, deposit_at, external_payment_id, status_raw, user_external_id')
    .eq('company_id', companyId)
    .eq('status_norm', 'completed')
    .eq('raw->>paymentProvider', CRM_PAYMENT_PROVIDER)
    .order('deposit_at', { ascending: false });

  if (error) throw new Error(`crm_deposits (paypros): ${error.message}`);

  const rows = (data ?? []) as unknown as CrmDepositRow[];

  const picked = selectUsableDeposits(rows);
  const usable = picked.usable;
  warnings.push(...picked.warnings);

  let upserted = 0;
  if (usable.length > 0) {
    const payload = usable.map((r) => ({
      company_id: companyId,
      provider: PROVIDER,
      external_id: `${CRM_ID_PREFIX}${r.external_id}`,
      amount: r.amount_paid,
      fee: 0,
      currency: r.coin ?? 'USD',
      status: ENTRY_STATUS,
      transaction_date: r.deposit_at,
      raw: {
        source: 'crm-orion',
        depositId: r.external_id,
        externalPaymentId: r.external_payment_id,
        userId: r.user_external_id,
        crmStatus: r.status_raw,
      },
    }));

    const { error: upsertErr } = await admin
      .from('api_transactions')
      .upsert(payload, { onConflict: 'company_id,provider,external_id' });

    if (upsertErr) throw new Error(`api_transactions (paypros): ${upsertErr.message}`);
    upserted = payload.length;
  }

  // ── Detección del doble conteo (ver cabecera) ───────────────────────────────
  const { count: webhookCount, error: countErr } = await admin
    .from('api_transactions')
    .select('external_id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('provider', PROVIDER)
    .not('external_id', 'like', `${CRM_ID_PREFIX}%`);

  if (countErr) {
    warnings.push(`No se pudo verificar el doble conteo: ${countErr.message}`);
  }
  const webhookRows = webhookCount ?? 0;
  if (webhookRows > 0) {
    warnings.push(
      `ATENCIÓN: hay ${webhookRows} movimiento(s) de Pay-Pros que NO vienen del CRM ` +
        `(el webhook quedó activo). El canal puede estar contando el mismo depósito dos veces: ` +
        `hay que elegir UNA fuente.`,
    );
  }

  return {
    found: rows.length,
    upserted,
    totalUsd: usable.reduce((s, r) => s + (r.amount_paid ?? 0), 0),
    webhookRows,
    warnings,
  };
}
