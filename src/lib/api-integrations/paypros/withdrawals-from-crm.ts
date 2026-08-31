// ─────────────────────────────────────────────────────────────────────────────
// Retiros de Pay-Pros — derivados del CRM, no del webhook.
//
// EL PEDIDO (Kevin, 2026-08-31)
// «de paypros en movimientos incluí también los retiros por ese medio».
// /movimientos mostraba Pay-Pros solo del lado de Depósitos.
//
// POR QUÉ ESTA FUENTE Y NO OTRA
// Había dos candidatas y la elección no es de gusto:
//
//   a) `api_transactions` con provider='paypros' y status='payout_paid'. Es lo
//      que TODO el resto del sistema ya sabe leer: el libro del canal (RPC
//      get_channel_day_movements, migración 082), `loadPersistedTotals`,
//      `countPayprosPayouts`. Pero al 2026-08-31 tiene **0 filas**: el receptor
//      de webhooks nunca recibió un evento porque la URL registrada con
//      Pay-Pros es la del CRM (srv6754.vexprofx.com), no la nuestra. Es la
//      misma historia que cuenta `deposits-from-crm.ts`.
//   b) `crm_withdrawals`, el espejo de Orion que ya sincronizamos cada 15
//      minutos. Al 2026-08-31 tiene 20 retiros con `processor` empezando en
//      'PAYPROS' (hoy todos 'PAYPROS_SPEI'), de los cuales **6 aprobados por
//      US$ 2.617,62**; los otros 14 son 13 rechazados y 1 cancelado.
//
// No son alternativas: (b) es de dónde sale el dato y (a) es dónde tiene que
// terminar. Este módulo hace exactamente lo mismo que su gemelo de depósitos —
// proyectar el espejo del CRM a `api_transactions`— y con eso las cuatro
// pantallas que ya cuentan 'payout_paid' se enteran solas, sin una quinta
// lista. Elegir (b) como fuente DIRECTA de la pantalla habría sido crear una
// segunda verdad al lado de la que ya existe: el modo de falla número uno del
// repo (docs/reglas-del-proyecto.md §1.1).
//
// QUÉ IMPORTE
// `requested_amount`, no `transaction_amount`. Es la regla §3.1 medida sobre
// 12.061 retiros: lo que sale de la billetera del cliente es lo pedido; la
// diferencia es la comisión (acá, $3 fijos en los 20 casos). Guardar el neto
// haría que Retiros Totales viniera corto por la suma de las comisiones.
//
// QUÉ FECHA
// `processed_at` — el día que la plata SALIÓ. Con `requested_at` un retiro
// pedido el 21 y ejecutado el 22 caería en el día equivocado, y el libro por
// canal, que cierra día a día contra el saldo real, no cuadraría.
//
// SOLO LOS APROBADOS
// `status_norm = 'approved'`. Un retiro rechazado o cancelado es plata que
// nunca salió: asentarlo diría que tenemos menos dinero del que hay. Mismo
// criterio estricto que los depósitos, y por la misma razón.
//
// EL RIESGO DE CONTAR DOS VECES
// Idéntico al de los depósitos: si algún día alguien registra nuestra URL de
// webhook, el mismo payout entraría por dos caminos con claves distintas y el
// índice único no podría evitarlo. Por eso el prefijo `crmw:` en el
// `external_id` y el conteo de filas de otra procedencia, que se REPORTA. Un
// descuadre que avisa es infinitamente mejor que uno silencioso (§1.2).
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';

/** Cómo Orion nombra a Pay-Pros en `withdrawals.processor`. Hoy: 'PAYPROS_SPEI'. */
export const CRM_PROCESSOR_PREFIX = 'PAYPROS';

/** El proveedor con el que el libro ya sabe leer Pay-Pros (migración 082). */
const PROVIDER = 'paypros';

/** Status con el que se asienta una SALIDA de Pay-Pros. */
const EXIT_STATUS = 'payout_paid';

/**
 * Prefijo de procedencia. Distinto del `crm:` de los depósitos a propósito: si
 * alguna vez un id de depósito y uno de retiro coincidieran en Orion, sin la
 * `w` se pisarían entre ellos (misma clave (company, provider, external_id)) y
 * un retiro borraría un depósito en silencio.
 */
export const CRM_WITHDRAWAL_ID_PREFIX = 'crmw:';

/** Moneda en la que cierra el canal. Ver `selectUsableWithdrawals`. */
const LEDGER_CURRENCY = 'USD';

export interface PayprosWithdrawalsFromCrmResult {
  /** Retiros de Pay-Pros aprobados encontrados en el espejo. */
  found: number;
  /** Filas escritas o actualizadas en api_transactions. */
  upserted: number;
  /** Suma en USD de lo asentado. */
  totalUsd: number;
  /** Filas 'payout_paid' que NO vienen del CRM (es decir: del webhook). */
  webhookRows: number;
  warnings: string[];
}

export interface CrmWithdrawalRow {
  external_id: string;
  requested_amount: number | null;
  transaction_amount: number | null;
  fee: number | null;
  coin: string | null;
  processor: string | null;
  status_raw: string | null;
  processed_at: string | null;
  user_external_id: string | null;
}

/**
 * Separa los retiros asentables de los que no, avisando por cada descarte.
 * Pura para poder fijarla con tests: acá se decide qué plata sale del libro.
 *
 * Los tres descartes, y por qué ninguno es silencioso:
 *   · sin `processed_at` → no se puede asentar en NINGÚN día.
 *   · sin importe        → no es un movimiento. Ojo: `null` ≠ `0`; los dos se
 *     descartan, pero por motivos distintos y el aviso lo dice.
 *   · moneda ≠ USD       → el libro del canal cierra contra un saldo en USD.
 *     Sumar una moneda local como si fuera dólar es EXACTAMENTE el hallazgo
 *     abierto de FairPay (ver migración 108): filas COP/CLP/CRC sumadas como
 *     USD. Hoy los 20 retiros de Pay-Pros son USD, así que este filtro no
 *     descarta nada — está para que el día que entre otra moneda se vea, en vez
 *     de inflar los retiros sin que nadie se entere.
 */
export function selectUsableWithdrawals(rows: CrmWithdrawalRow[]): {
  usable: CrmWithdrawalRow[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const usable = rows.filter((r) => {
    if (!r.processed_at) {
      warnings.push(`Retiro ${r.external_id} sin fecha de procesamiento: no se puede asentar.`);
      return false;
    }
    if (r.requested_amount === null || r.requested_amount === undefined) {
      warnings.push(`Retiro ${r.external_id} sin importe pedido (null): no se sabe cuánto salió, se omite.`);
      return false;
    }
    if (!(r.requested_amount > 0)) {
      warnings.push(`Retiro ${r.external_id} con importe ${r.requested_amount}: no es un movimiento, se omite.`);
      return false;
    }
    const coin = (r.coin ?? LEDGER_CURRENCY).trim().toUpperCase();
    if (coin !== LEDGER_CURRENCY) {
      warnings.push(
        `Retiro ${r.external_id} en ${coin}: el canal cierra en ${LEDGER_CURRENCY} y no hay conversión. ` +
          `Se omite para no sumar monedas distintas como si fueran dólares.`,
      );
      return false;
    }
    return true;
  });
  return { usable, warnings };
}

/**
 * Proyecta los retiros Pay-Pros aprobados del espejo del CRM a
 * `api_transactions`, que es de donde salen los retiros del canal.
 *
 * Idempotente: la clave `(company_id, provider, external_id)` tiene índice
 * único y el id del retiro en Orion no cambia.
 */
export async function syncPayprosWithdrawalsFromCrm(
  admin: SupabaseClient,
  companyId: string,
): Promise<PayprosWithdrawalsFromCrmResult> {
  const warnings: string[] = [];

  const { data, error } = await admin
    .from('crm_withdrawals')
    .select(
      'external_id, requested_amount, transaction_amount, fee, coin, processor, status_raw, processed_at, user_external_id',
    )
    .eq('company_id', companyId)
    .eq('status_norm', 'approved')
    // `like` y no `eq`: hoy el único valor es 'PAYPROS_SPEI', pero el nombre
    // lleva el RAIL adentro (SPEI es México). Cuando entre PIX o cualquier otro,
    // un `eq('PAYPROS_SPEI')` lo dejaría afuera sin que nada fallara.
    .like('processor', `${CRM_PROCESSOR_PREFIX}%`)
    .order('processed_at', { ascending: false });

  if (error) throw new Error(`crm_withdrawals (paypros): ${error.message}`);

  const rows = (data ?? []) as unknown as CrmWithdrawalRow[];

  const picked = selectUsableWithdrawals(rows);
  const usable = picked.usable;
  warnings.push(...picked.warnings);

  let upserted = 0;
  if (usable.length > 0) {
    const payload = usable.map((r) => ({
      company_id: companyId,
      provider: PROVIDER,
      external_id: `${CRM_WITHDRAWAL_ID_PREFIX}${r.external_id}`,
      // requested_amount: lo que sale de la billetera (§3.1).
      amount: r.requested_amount,
      fee: r.fee ?? 0,
      currency: r.coin ?? LEDGER_CURRENCY,
      status: EXIT_STATUS,
      transaction_date: r.processed_at,
      raw: {
        source: 'crm-orion',
        kind: 'withdrawal',
        withdrawalId: r.external_id,
        processor: r.processor,
        userId: r.user_external_id,
        crmStatus: r.status_raw,
        transactionAmount: r.transaction_amount,
      },
    }));

    const { error: upsertErr } = await admin
      .from('api_transactions')
      .upsert(payload, { onConflict: 'company_id,provider,external_id' });

    if (upsertErr) throw new Error(`api_transactions (paypros payouts): ${upsertErr.message}`);
    upserted = payload.length;
  }

  // ── Detección del doble conteo (ver cabecera) ─────────────────────────────
  const { count: webhookCount, error: countErr } = await admin
    .from('api_transactions')
    .select('external_id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('provider', PROVIDER)
    .eq('status', EXIT_STATUS)
    .not('external_id', 'like', `${CRM_WITHDRAWAL_ID_PREFIX}%`);

  if (countErr) {
    warnings.push(`No se pudo verificar el doble conteo de retiros: ${countErr.message}`);
  }
  const webhookRows = webhookCount ?? 0;
  if (webhookRows > 0) {
    warnings.push(
      `ATENCIÓN: hay ${webhookRows} retiro(s) de Pay-Pros que NO vienen del CRM ` +
        `(el webhook quedó activo). Retiros Totales puede estar contando el mismo ` +
        `payout dos veces: hay que elegir UNA fuente.`,
    );
  }

  return {
    found: rows.length,
    upserted,
    totalUsd: usable.reduce((s, r) => s + (r.requested_amount ?? 0), 0),
    webhookRows,
    warnings,
  };
}
