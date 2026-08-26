// ─────────────────────────────────────────────────────────────────────────────
// Qué cuenta CUENTA: el criterio único de alcance del módulo de riesgo.
//
// ── LA REGLA ───────────────────────────────────────────────────────────────
// Cuenta que no está vinculada al CRM, no entra a ninguna cifra (Kevin,
// 2026-08-26). Ni al PNL, ni a la exposición, ni al riesgo de margen.
//
// ── POR QUÉ HACE FALTA DECIRLO ─────────────────────────────────────────────
// Porque en MetaTrader hay más cuentas que en el CRM y no hay NADA en el dato
// de MT5 que las distinga. Medido el 2026-08-26:
//
//     cuentas reales en MT5      24.415
//     cuentas live en el CRM     23.275
//     diferencia                  1.140   <-- pruebas
//
// Operan, abren posiciones, usan margen y generan PNL igual que cualquier
// cliente. Sin este filtro entran a los informes con cara de negocio real.
// Medido: el PNL cerrado en USD de un día se infla de 6.198 a 12.836.
//
// ── ESTE ARCHIVO EXISTE PARA QUE HAYA UN SOLO CRITERIO ─────────────────────
// El filtro empezó viviendo dentro del módulo de PNL. En cuanto la exposición
// tuvo que aplicar el mismo criterio, copiarlo habría dado dos definiciones de
// "cuenta válida" que se ven idénticas hasta el día que una cambia. Y ese día
// el síntoma no es un error: son dos pantallas del mismo módulo que muestran
// distinto número de cuentas.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Logins por consulta. PostgREST manda el `in(...)` en la URL, así que un lote
 * grande la desborda; 300 deja margen de sobra.
 */
const LOTE = 300;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * De los logins dados, cuáles existen en el CRM como cuenta LIVE.
 *
 * Se pregunta sólo por los que aparecieron en MT5 (unos cientos en una corrida
 * normal) en vez de bajarse las 23.275 del CRM: traer 24 páginas de Supabase
 * para descartar un puñado es pagar el viaje al revés.
 *
 * Devuelve un Set para que el llamador filtre y, sobre todo, CUENTE lo que
 * quedó afuera. Una exclusión silenciosa es indistinguible de un cruce roto.
 */
export async function liveCrmLogins(
  admin: SupabaseClient,
  companyId: string,
  logins: number[],
): Promise<Set<number>> {
  const dentro = new Set<number>();
  const unicos = [...new Set(logins.filter((n) => Number.isFinite(n) && n > 0))];

  for (const part of chunk(unicos, LOTE)) {
    const { data, error } = await admin
      .from('crm_trading_accounts')
      .select('login')
      .eq('company_id', companyId)
      .eq('is_live', true)
      .in('login', part);
    if (error) throw new Error(`crm_trading_accounts: ${error.message}`);
    for (const r of data ?? []) dentro.add(Number(r.login));
  }
  return dentro;
}
