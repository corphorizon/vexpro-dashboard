import 'server-only';
import { NextResponse } from 'next/server';
import type { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import {
  CONFLICTO_PERIODO,
  huellaDeEgresosManuales,
  mensajeConflicto,
  mismaHuella,
  parsearHuella,
  type HuellaEgresos,
} from './huella-periodo';

// ─────────────────────────────────────────────────────────────────────────────
// Lado servidor del guard de huella (ver huella-periodo.ts para el porqué).
//
// Vive aparte del helper puro para que el test de la huella no arrastre el
// admin client, y en UN solo lugar porque lo usan DOS rutas que escriben los
// egresos del período desde /upload: POST /api/admin/expenses (la RPC que
// pisa el período) y el op `expense_order` de /api/admin/data (reordenar sube
// updated_at vía trigger, así que también mueve la huella). Si cada ruta
// armara su 409 a mano, el cliente terminaría reconociendo uno y no el otro.
// ─────────────────────────────────────────────────────────────────────────────

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Huella ACTUAL del período, leída con el admin client (RLS no aplica: el
 * `company_id` explícito es obligatorio y tiene que salir del token).
 *
 * Se pide `count: 'exact'` para no comparar contra una lectura recortada: si
 * PostgREST cortara por max-rows, el count saldría bajo y la huella sería un
 * número plausible y equivocado. Recorte ⇒ error explícito, nunca huella.
 */
export async function leerHuellaDelPeriodo(
  admin: AdminClient,
  companyId: string,
  periodId: string,
): Promise<HuellaEgresos> {
  const { data, error, count } = await admin
    .from('expenses')
    .select('id, payment_order_id, updated_at', { count: 'exact' })
    .eq('company_id', companyId)
    .eq('period_id', periodId);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ payment_order_id: string | null; updated_at: string | null }>;
  if (count != null && count !== rows.length) {
    throw new Error(`lectura de la huella recortada: ${rows.length} de ${count} filas`);
  }
  return huellaDeEgresosManuales(rows);
}

/**
 * Chequeo previo a una escritura del período. Devuelve `null` si se puede
 * seguir, o la respuesta a devolver tal cual:
 *   · baseline undefined/null → null (cliente viejo en caché, sin guard: ver
 *     la cabecera de api/admin/expenses/route.ts).
 *   · baseline mal formado → 400. No es un cliente viejo, y degradarlo a
 *     "guardar sin guard" sería pisar a ciegas.
 *   · no se pudo leer la huella → 500 (fail-closed: sin huella no se sabe si
 *     la escritura pisaría algo).
 *   · huella distinta → 409 `conflict` con los números de las dos puntas.
 */
export async function verificarHuella(
  admin: AdminClient,
  companyId: string,
  periodId: string,
  rawBaseline: unknown,
  contexto: string,
): Promise<NextResponse | null> {
  if (rawBaseline === undefined || rawBaseline === null) return null;
  const baseline = parsearHuella(rawBaseline);
  if (!baseline) {
    return NextResponse.json(
      { success: false, error: 'baseline inválido: se espera { count, maxUpdatedAt }' },
      { status: 400 },
    );
  }

  let actual: HuellaEgresos;
  try {
    actual = await leerHuellaDelPeriodo(admin, companyId, periodId);
  } catch (err) {
    return apiError(`${contexto} huella`, err, {
      status: 500,
      clientMessage: 'No se pudo verificar si el período cambió. Probá de nuevo en unos segundos.',
    });
  }
  if (mismaHuella(actual, baseline)) return null;

  // Rastro server-side de cada pisón evitado: el incidente del 2026-10-08 no
  // dejó NINGUNO, y contar cuántas veces pasa es lo que dirá si hace falta
  // cerrar la ventana de carrera con una migración.
  console.warn(`[${contexto}] escritura bloqueada: el período cambió`, {
    companyId,
    periodId,
    baseline,
    actual,
  });
  return NextResponse.json(
    {
      success: false,
      error: CONFLICTO_PERIODO,
      mensaje: mensajeConflicto(actual, baseline),
      actual,
    },
    { status: 409 },
  );
}

/**
 * Huella NUEVA tras una escritura exitosa, para que el cliente re-sincronice
 * su baseline sin refetch. Se relee (no se deduce del payload) porque los
 * updated_at los pone la base. Si la relectura falla la escritura YA ocurrió:
 * no se reporta como error, se devuelve null = "no se pudo releer" y el
 * cliente se queda con la huella que siembre su re-sync desde la base.
 */
export async function releerHuella(
  admin: AdminClient,
  companyId: string,
  periodId: string,
  contexto: string,
): Promise<HuellaEgresos | null> {
  try {
    return await leerHuellaDelPeriodo(admin, companyId, periodId);
  } catch (err) {
    console.error(`[${contexto}] relectura de huella falló (no fatal):`, err);
    return null;
  }
}
