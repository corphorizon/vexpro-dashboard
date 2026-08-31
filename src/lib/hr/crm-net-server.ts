import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RollupProfile } from './net-deposit';

// ─────────────────────────────────────────────────────────────────────────────
// Las DOS lecturas que necesita cualquier pantalla que quiera el net del CRM:
// la estructura comercial y el rollup por perfil.
//
// ── El porqué ──────────────────────────────────────────────────────────────
// Estaban copiadas en `/api/admin/hr-net-deposit-rollup` y en
// `/api/admin/hr-overview`, y la tanda 2 agregaba una tercera copia en
// `/api/admin/commission-net-input`. Tres copias del mismo paginado y de la
// misma RPC es exactamente el modo de falla número uno del repo (§1.1): el día
// que la RPC cambie de firma —ya pasó dos veces, migraciones 113 y 114— hay que
// acordarse de las tres.
//
// Las dos devuelven `null` cuando fallan, NUNCA `[]`: una lista vacía muda es
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
