import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RollupProfile } from './net-deposit';

// ─────────────────────────────────────────────────────────────────────────────
// Las lecturas que necesita cualquier pantalla que quiera los insumos del CRM
// para RRHH: la estructura comercial, el rollup de net deposit por perfil, y
// (desde la migración 123) los dos insumos del grupo PnL.
//
// ── El porqué ──────────────────────────────────────────────────────────────
// Estaban copiadas en `/api/admin/hr-net-deposit-rollup` y en
// `/api/admin/hr-overview`, y la tanda 2 agregaba una tercera copia en
// `/api/admin/commission-net-input`. Tres copias del mismo paginado y de la
// misma RPC es exactamente el modo de falla número uno del repo (§1.1): el día
// que la RPC cambie de firma —ya pasó dos veces, migraciones 113 y 114— hay que
// acordarse de las tres.
//
// Las tres devuelven `null` cuando fallan, NUNCA `[]`: una lista vacía muda es
// indistinguible de un cruce roto (§1.2). El llamador decide si eso es un 502 o
// un slice `partial`.
// ─────────────────────────────────────────────────────────────────────────────

/** PostgREST corta en 1.000 filas SIN AVISAR. Hoy hay 126 perfiles. */
const PAGE = 1000;

/** Lo que devuelve la RPC `hr_net_deposit_by_profile`. `profile_id` NULL = huérfanos. */
export type CrmNetRow = { profile_id: string | null; net: number | string };

/**
 * TODOS los perfiles comerciales, incluidos los despedidos: un BDM que se fue
 * el 20 igual produjo hasta ese día y su plata tiene que aparecer bajo su head,
 * o el total del equipo no cierra contra el CRM.
 */
export async function leerPerfilesComerciales(
  admin: SupabaseClient,
  companyId: string,
): Promise<RollupProfile[] | null> {
  const out: RollupProfile[] = [];
  for (let from = 0; ; from += PAGE) {
    let data: unknown[] | null;
    try {
      const res = await admin
        .from('commercial_profiles')
        .select('id, name, role, head_id, salary, hire_date, status, termination_date')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (res.error) {
        console.error('[crm-net] perfiles falló:', res.error);
        return null;
      }
      data = res.data;
    } catch (err) {
      console.error('[crm-net] perfiles lanzó:', err);
      return null;
    }
    out.push(...((data ?? []) as RollupProfile[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/**
 * El net del mes por perfil, tal como sale de la RPC.
 *
 * El trabajo pesado (subir la cadena de sponsors de 21.182 clientes) lo hace
 * Postgres — migración 097, llaves canónicas de monto en la 113, un perfil por
 * usuario en la 114, índices y timeout propio en la 115. Acá no se agrega nada:
 * separar lo atribuido de lo huérfano y armar el árbol es puro y vive en
 * overview.ts / net-deposit.ts.
 *
 * `p_month` es el día 1 del mes (`YYYY-MM-01`), la única forma que acepta.
 */
export async function leerNetDelCrm(
  admin: SupabaseClient,
  companyId: string,
  month: string,
): Promise<CrmNetRow[] | null> {
  try {
    const { data, error } = await admin.rpc('hr_net_deposit_by_profile', {
      p_company_id: companyId,
      p_month: month,
    });
    if (error) {
      console.error('[crm-net] rollup falló:', error);
      return null;
    }
    return (data ?? []) as CrmNetRow[];
  } catch (err) {
    console.error('[crm-net] rollup lanzó:', err);
    return null;
  }
}

/**
 * Lo que devuelve la RPC `hr_pnl_input_by_profile` (migración 123).
 *
 * UNA fila por perfil con `pnl_pct` no nulo. Los tres campos vienen en `numeric`
 * y PostgREST puede entregarlos como texto, igual que el `net` del rollup — por
 * eso `number | string` y la conversión la hace quien consume.
 *
 * LOS TRES ESTADOS (§1.3, y la cabecera de la 123 los enumera):
 *   · `pnl_crm`/`com_lotes`/`usuarios_red` los TRES en `null` → el perfil no
 *     tiene usuario en el CRM. "No lo sabemos", que NO es cero.
 *   · `0` → hay usuario y no hubo actividad: el Commissions Report muestra
 *     $0.00 y el PNL Report "0 records". Es un cero MEDIDO.
 *   · `pnl_crm` null con `com_lotes` numérico → hubo actividad pero el PNL no
 *     fue calculable (todas las `pnl_usd` nulas). Tampoco es cero.
 */
export type CrmPnlInputRow = {
  profile_id: string;
  /**
   * SIGNO CRUDO DEL CRM: negativo = los clientes perdieron = el bróker ganó.
   * La pantalla de comisiones lo muestra AL REVÉS (lo que la empresa gana) y
   * esa inversión la hace `/api/admin/commission-net-input`, UN SOLO LUGAR.
   * Acá no se toca: la 123 devuelve crudo a propósito para que no convivan una
   * RPC invertida y otra que no sobre la misma columna del mismo espejo.
   */
  pnl_crm: number | string | null;
  com_lotes: number | string | null;
  usuarios_red: number | string | null;
};

/**
 * Los dos insumos del grupo PnL del mes, por perfil, tal como salen de la RPC.
 *
 * El trabajo pesado (bajar la subred entera del perfil por el árbol canónico de
 * patrocinio y agregar el mes de `crm_daily_pnl_users`) lo hace Postgres —
 * migración 123, calibrada contra los dos reports oficiales del CRM en junio
 * 2026 (diegonanolopez −6.336,14 / 3.399,39 y millonariosteam2018
 * 149.208,29 / 45.924,62). Acá no se agrega nada.
 *
 * `p_month` es el día 1 del mes (`YYYY-MM-01`), la única forma que acepta.
 *
 * Devuelve `null` cuando falla, NUNCA `[]`: un array vacío se leería como
 * "ningún perfil PnL produjo este mes" y la pantalla llenaría los campos con
 * ceros automáticos (§1.2).
 */
export async function leerPnlInputDelCrm(
  admin: SupabaseClient,
  companyId: string,
  month: string,
): Promise<CrmPnlInputRow[] | null> {
  try {
    const { data, error } = await admin.rpc('hr_pnl_input_by_profile', {
      p_company_id: companyId,
      p_month: month,
    });
    if (error) {
      console.error('[crm-net] insumo PnL falló:', error);
      return null;
    }
    return (data ?? []) as CrmPnlInputRow[];
  } catch (err) {
    console.error('[crm-net] insumo PnL lanzó:', err);
    return null;
  }
}
