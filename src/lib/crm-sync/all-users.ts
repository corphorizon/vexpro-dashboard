// ─────────────────────────────────────────────────────────────────────────────
// Espejado del universo COMPLETO de usuarios de Orion.
//
// POR QUÉ HACE FALTA
// El sync original sólo traía a los usuarios que aparecían en un movimiento:
// correcto para revisar retiros, insuficiente para reemplazar el sync de
// Atlas. Medido el 2026-08-25: 8.718 espejados contra 20.918 que hay en Orion.
// Faltaban 12.200 — los que nunca depositaron ni retiraron, que son justamente
// a los que el call center llama.
//
// ── EL CURSOR VA CON $gte, NO CON $gt ──────────────────────────────────────
// Dos usuarios pueden compartir milisegundo en `updatedAt`. Con `$gt`, si el
// corte cae entre ellos, el segundo se pierde PARA SIEMPRE: el cursor avanza y
// nadie vuelve a mirarlo. El coste de `$gte` es releer el documento del borde;
// el coste de `$gt` es un cliente que desaparece sin que nadie lo note.
// (Aviso de la sesión de Atlas, que ya lo tenía resuelto así.)
//
// ── Y `users` NO TIENE ÍNDICE POR updatedAt ────────────────────────────────
// Verificado por Atlas el 21/08. Mientras el volumen sea de 20.918 documentos
// el barrido es tolerable, pero si vamos a ser el único lector de esa base, es
// el momento de pedirle ese índice a Orion. Queda anotado acá porque es donde
// se va a notar cuando la colección crezca.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';
import { withOrionMongo } from '@/lib/api-integrations/orion-mongo/client';
import { toUserRow } from './normalize';
import { ORION_USER_FIELDS } from './sync';

const PAGE = 1000;
const UPSERT = 500;

export interface AllUsersResult {
  fetched: number;
  upserted: number;
  elapsedMs: number;
  /** Marca más alta vista, para la próxima corrida. */
  cursor: string | null;
  warnings: string[];
}

/**
 * Espeja todos los usuarios modificados desde `since` (inclusive). Sin
 * `since`, recorre la colección entera.
 */
export async function syncAllOrionUsers(
  admin: SupabaseClient,
  companyId: string,
  since: string | null,
): Promise<AllUsersResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const projection = Object.fromEntries(ORION_USER_FIELDS.map((f) => [f, 1]));

  const { rows, maxUpdated } = await withOrionMongo(companyId, async ({ db }) => {
    // `$gte` a propósito: ver la cabecera.
    const filter = since ? { updatedAt: { $gte: new Date(since) } } : {};
    const cursor = db
      .collection('users')
      .find(filter, { projection, batchSize: PAGE })
      .sort({ updatedAt: 1 });

    const out: Record<string, unknown>[] = [];
    let max: string | null = null;
    for await (const doc of cursor) {
      const row = toUserRow(doc as never, companyId);
      if (!row) continue;
      out.push(row as unknown as Record<string, unknown>);
      const upd = (doc as { updatedAt?: unknown }).updatedAt;
      const iso = upd instanceof Date ? upd.toISOString() : typeof upd === 'string' ? upd : null;
      if (iso && (!max || iso > max)) max = iso;
    }
    return { rows: out, maxUpdated: max };
  });

  let upserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT) {
    const part = rows.slice(i, i + UPSERT);
    const { error } = await admin
      .from('crm_user_snapshots')
      .upsert(part, { onConflict: 'company_id,user_external_id' });
    if (error) throw new Error(`crm_user_snapshots: ${error.message}`);
    upserted += part.length;
  }

  // Un cursor que no avanza convierte cada corrida en un barrido completo. Si
  // no vino ningún `updatedAt` es que la colección no lo trae, y hay que
  // saberlo antes de que el coste se note.
  if (rows.length > 0 && !maxUpdated) {
    warnings.push('Ningún usuario trajo `updatedAt`: el cursor no puede avanzar y cada corrida será completa.');
  }

  return {
    fetched: rows.length,
    upserted,
    elapsedMs: Date.now() - started,
    cursor: maxUpdated,
    warnings,
  };
}
