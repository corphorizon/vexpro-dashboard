// ─────────────────────────────────────────────────────────────────────────────
// Sync CRM (Orion Mongo) → Supabase. Fase A del módulo de Revisión de Retiros.
//
// POR QUÉ: el dashboard corre en Vercel serverless. Abrir el Mongo del broker
// en cada carga de pantalla es lento, frágil y le mete carga a SU producción.
// Igual que las pasarelas: un cron trae los datos, las pantallas leen NUESTRA
// base (migración 088). Si el CRM se cae, el módulo sigue con el último dato
// bueno.
//
// ── CURSOR INCREMENTAL: cómo y por qué ──────────────────────────────────────
// El cursor es el MÁXIMO `updatedAt` (con respaldo en `createdAt`) de los
// documentos que efectivamente leímos del CRM, guardado por empresa y por
// colección en `audit_logs` (module='crm_sync'), y se vuelve a aplicar con un
// SOLAPE de 48 h.
//
// Se descartaron las alternativas:
//   · `max(synced_at)` de nuestras tablas → es NUESTRO reloj, no el del CRM.
//     Si una corrida no trae nada, o si los relojes difieren, se pierden filas.
//   · `max(requested_at/deposit_at)` → esas son fechas de NEGOCIO: un retiro
//     pedido el lunes y resuelto el viernes cambia de estado sin mover su
//     requestedDate, así que el cambio nunca entraría. Justo lo que el módulo
//     necesita ver.
//   · Una tabla nueva de cursores → la migración 088 está aplicada y es el
//     contrato; no la tocamos. `audit_logs` ya se usa para exactamente esto en
//     integrations-sync.ts.
//
// El solape de 48 h cubre relojes desfasados del cluster del broker y
// documentos escritos con un updatedAt anterior al momento de la escritura.
// Re-leer 48 h es barato y es SEGURO: todo se escribe con
// `upsert(onConflict: 'company_id,external_id')`, así que reprocesar es
// idempotente por construcción. Si no hay cursor previo (o `full: true`), se
// recorre el histórico entero sin filtro.
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';
import type { Document, Filter } from 'mongodb';
import { createAdminClient } from '@/lib/supabase/admin';
import { withOrionMongo, type OrionMongoSession } from '@/lib/api-integrations/orion-mongo/client';
import {
  docWatermark,
  isAbsurdDepositValue,
  toDepositRow,
  toStr,
  toUserRow,
  toWithdrawalRow,
} from './normalize';
import type {
  CrmDepositRow,
  CrmSyncCollectionStats,
  CrmSyncCursors,
  CrmSyncResult,
  CrmWithdrawalRow,
  MongoDoc,
} from './types';

type AdminClient = ReturnType<typeof createAdminClient>;

/** Tamaño del batch que pide el driver de Mongo (no cargamos todo en memoria). */
const FETCH_BATCH = 1_000;
/** Filas por upsert. 500 mantiene el payload de PostgREST en un tamaño sano. */
const UPSERT_CHUNK = 500;
/** userIds por `$in`. Más de 200 hace que el planner de Mongo se ponga tonto. */
const USER_ID_CHUNK = 200;
/** Solape del cursor: se re-lee siempre desde 48 h antes del máximo conocido. */
const CURSOR_OVERLAP_MS = 48 * 60 * 60 * 1000;

const AUDIT_MODULE = 'crm_sync';

export interface RunCrmSyncOptions {
  companyId: string;
  /** Fuerza el punto de partida (ISO). Pisa el cursor guardado. */
  sinceIso?: string | null;
  /** true = ignora el cursor y recorre todo el histórico. */
  full?: boolean;
}

// ── Cursor ───────────────────────────────────────────────────────────────────

/** Aplica el solape de 48 h a un cursor guardado. */
function withOverlap(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t - CURSOR_OVERLAP_MS).toISOString();
}

/** El mayor de dos ISO (cualquiera puede ser null). */
function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

async function loadCursors(admin: AdminClient, companyId: string): Promise<CrmSyncCursors> {
  const { data, error } = await admin
    .from('audit_logs')
    .select('details')
    .eq('module', AUDIT_MODULE)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return { withdrawals: null, deposits: null };

  try {
    const parsed = (
      typeof data.details === 'string' ? JSON.parse(data.details) : data.details
    ) as { cursors?: Partial<CrmSyncCursors> } | null;
    return {
      withdrawals: parsed?.cursors?.withdrawals ?? null,
      deposits: parsed?.cursors?.deposits ?? null,
    };
  } catch {
    // Un log corrupto no puede bloquear el sync: se cae a carga completa, que
    // es lenta pero correcta.
    return { withdrawals: null, deposits: null };
  }
}

async function saveRun(
  admin: AdminClient,
  companyId: string,
  cursors: CrmSyncCursors,
  summary: CrmSyncResult,
): Promise<void> {
  const { error } = await admin.from('audit_logs').insert({
    company_id: companyId,
    user_id: null,
    user_name: 'cron',
    action: 'sync',
    module: AUDIT_MODULE,
    details: JSON.stringify({ cursors, summary }),
  });
  // Si falla el log el sync ya escribió los datos: no rompemos, pero la
  // próxima corrida hará carga completa (idempotente, sólo más lenta).
  if (error) console.error('[crm-sync] no se pudo guardar el cursor:', error.message);
}

// ── Escritura ────────────────────────────────────────────────────────────────

/** Upsert por lotes. Devuelve cuántas filas se escribieron. */
async function upsertRows(
  admin: AdminClient,
  table: string,
  rows: Record<string, unknown>[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const { error } = await admin.from(table).upsert(rows, { onConflict: 'company_id,external_id' });
  if (error) throw new Error(`upsert ${table}: ${error.message}`);
  return rows.length;
}

async function upsertUserRows(
  admin: AdminClient,
  rows: Record<string, unknown>[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const { error } = await admin
    .from('crm_user_snapshots')
    .upsert(rows, { onConflict: 'company_id,user_external_id' });
  if (error) throw new Error(`upsert crm_user_snapshots: ${error.message}`);
  return rows.length;
}

// ── Lectura en streaming ─────────────────────────────────────────────────────

interface StreamOptions<TRow> {
  session: OrionMongoSession;
  admin: AdminClient;
  collectionName: string;
  filter: Filter<Document>;
  /** Clave de deduplicación dentro de la corrida (= external_id). */
  keyOf: (row: TRow) => string;
  map: (doc: MongoDoc) => TRow | null;
  flush: (rows: TRow[]) => Promise<number>;
  /** Gancho por documento crudo: contadores, recolección de userIds, etc. */
  onDoc?: (doc: MongoDoc) => void;
}

/**
 * Recorre una colección con cursor (batches de 1.000) y va escribiendo de a
 * 500. Nunca materializa la colección entera: la primera corrida de Vex Pro
 * son 39.413 depósitos y una función de Vercel no tiene memoria para eso ni
 * motivo para gastarla.
 */
async function streamCollection<TRow>(
  opts: StreamOptions<TRow>,
): Promise<CrmSyncCollectionStats & { maxUpdatedAt: string | null }> {
  const cursor = opts.session.db
    .collection(opts.collectionName)
    .find(opts.filter, { batchSize: FETCH_BATCH });

  let fetched = 0;
  let upserted = 0;
  let maxUpdatedAt: string | null = null;
  let buffer: TRow[] = [];
  // Un mismo external_id dos veces en el MISMO payload hace fallar el upsert
  // entero ("ON CONFLICT DO UPDATE cannot affect row a second time"). Con el
  // solape de 48 h y un CRM que ya tuvo un typo de estado, no descartamos
  // duplicados: nos quedamos con la primera aparición.
  const seen = new Set<string>();

  try {
    for await (const raw of cursor) {
      const doc = raw as MongoDoc;
      fetched++;
      opts.onDoc?.(doc);
      maxUpdatedAt = maxIso(maxUpdatedAt, docWatermark(doc));

      const row = opts.map(doc);
      if (!row) continue;
      const key = opts.keyOf(row);
      if (seen.has(key)) continue;
      seen.add(key);

      buffer.push(row);
      if (buffer.length >= UPSERT_CHUNK) {
        upserted += await opts.flush(buffer);
        buffer = [];
      }
    }
    if (buffer.length > 0) upserted += await opts.flush(buffer);
  } finally {
    await cursor.close().catch(() => {});
  }

  return { fetched, upserted, maxUpdatedAt };
}

/**
 * Filtro incremental. Los documentos SIN `updatedAt` se pescan por `createdAt`
 * (`updatedAt: null` en Mongo matchea también el campo ausente): si sólo
 * filtráramos por updatedAt, esos docs quedarían fuera del espejo para siempre.
 */
function incrementalFilter(sinceIso: string | null): Filter<Document> {
  if (!sinceIso) return {};
  const since = new Date(sinceIso);
  return {
    $or: [
      { updatedAt: { $gte: since } },
      { updatedAt: null, createdAt: { $gte: since } },
    ],
  };
}

// ── Sync ─────────────────────────────────────────────────────────────────────

const EMPTY_STATS: CrmSyncCollectionStats = { fetched: 0, upserted: 0 };

/**
 * Trae retiros, depósitos y perfiles del CRM de una empresa al espejo de la
 * migración 088. Idempotente (upsert por (company_id, external_id)) e
 * incremental (ver la nota del cursor en la cabecera).
 *
 * Un fallo en una colección NO impide las otras: se registra en `errors` y el
 * cursor de esa colección queda como estaba, para que la próxima corrida
 * reintente desde el mismo punto.
 */
export async function runCrmSync(opts: RunCrmSyncOptions): Promise<CrmSyncResult> {
  const startedAt = Date.now();
  const ranAt = new Date().toISOString();
  const { companyId, full = false } = opts;

  const admin = createAdminClient();
  const previous = full ? { withdrawals: null, deposits: null } : await loadCursors(admin, companyId);

  const since: CrmSyncCursors = {
    withdrawals: full ? null : (opts.sinceIso ?? withOverlap(previous.withdrawals)),
    deposits: full ? null : (opts.sinceIso ?? withOverlap(previous.deposits)),
  };

  const errors: string[] = [];
  const unknownStatuses = new Set<string>();
  let corruptDepositValues = 0;

  let withdrawals: CrmSyncCollectionStats = { ...EMPTY_STATS };
  let deposits: CrmSyncCollectionStats = { ...EMPTY_STATS };
  let users: CrmSyncCollectionStats = { ...EMPTY_STATS };
  const nextCursors: CrmSyncCursors = { ...previous };

  // userId crudo indexado por su forma string: el `$in` necesita el valor tal
  // cual lo guarda el CRM, pero deduplicar necesita una clave comparable.
  const userIds = new Map<string, unknown>();

  try {
    await withOrionMongo(companyId, async (session) => {
      // ── Retiros ───────────────────────────────────────────────────────────
      try {
        const res = await streamCollection<CrmWithdrawalRow>({
          session,
          admin,
          collectionName: 'withdrawals',
          filter: incrementalFilter(since.withdrawals),
          keyOf: (row) => row.external_id,
          map: (doc) => {
            const row = toWithdrawalRow(doc, companyId, ranAt);
            if (row) {
              if (row.status_norm === 'unknown' && row.status_raw) {
                unknownStatuses.add(`withdrawals:${row.status_raw}`);
              }
              const uid = toStr(doc.userId);
              if (uid && !userIds.has(uid)) userIds.set(uid, doc.userId);
            }
            return row;
          },
          flush: (rows) => upsertRows(admin, 'crm_withdrawals', rows as unknown as Record<string, unknown>[]),
        });
        withdrawals = { fetched: res.fetched, upserted: res.upserted };
        nextCursors.withdrawals = maxIso(previous.withdrawals, res.maxUpdatedAt);
      } catch (err) {
        errors.push(`withdrawals: ${err instanceof Error ? err.message : String(err)}`);
      }

      // ── Depósitos ─────────────────────────────────────────────────────────
      try {
        const res = await streamCollection<CrmDepositRow>({
          session,
          admin,
          collectionName: 'deposits',
          filter: incrementalFilter(since.deposits),
          keyOf: (row) => row.external_id,
          map: (doc) => {
            // Trampa 1: contamos cuántos depositValue absurdos descartamos.
            if (isAbsurdDepositValue(doc.depositValue)) corruptDepositValues++;
            const row = toDepositRow(doc, companyId, ranAt);
            if (row) {
              if (row.status_norm === 'unknown' && row.status_raw) {
                unknownStatuses.add(`deposits:${row.status_raw}`);
              }
              const uid = toStr(doc.userId);
              if (uid && !userIds.has(uid)) userIds.set(uid, doc.userId);
            }
            return row;
          },
          flush: (rows) => upsertRows(admin, 'crm_deposits', rows as unknown as Record<string, unknown>[]),
        });
        deposits = { fetched: res.fetched, upserted: res.upserted };
        nextCursors.deposits = maxIso(previous.deposits, res.maxUpdatedAt);
      } catch (err) {
        errors.push(`deposits: ${err instanceof Error ? err.message : String(err)}`);
      }

      // ── Usuarios ──────────────────────────────────────────────────────────
      // Sólo los que aparecen en lo que acabamos de sincronizar. Traer las
      // decenas de miles de usuarios del CRM en cada corrida sería regalarle
      // carga al broker por datos que el módulo no mira.
      try {
        users = await syncUsers(session, admin, companyId, userIds, ranAt);
      } catch (err) {
        errors.push(`users: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  } catch (err) {
    // Falla la conexión entera (credencial ausente, timeout, DNS…).
    errors.push(`connection: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result: CrmSyncResult = {
    companyId,
    ranAt,
    full,
    since,
    withdrawals,
    deposits,
    users,
    unknownStatuses: [...unknownStatuses].sort(),
    corruptDepositValues,
    cursors: nextCursors,
    elapsedMs: Date.now() - startedAt,
    errors,
  };

  // Un estado nuevo del CRM es una novedad de producto, no ruido: hay que
  // verlo en los logs aunque el sync haya terminado "bien".
  if (result.unknownStatuses.length > 0) {
    console.warn(
      `[crm-sync] ${companyId}: estados desconocidos del CRM → ${result.unknownStatuses.join(', ')}`,
    );
  }

  await saveRun(admin, companyId, nextCursors, result);
  return result;
}

/** Trae y espeja sólo los usuarios referenciados por los movimientos leídos. */
async function syncUsers(
  session: OrionMongoSession,
  admin: AdminClient,
  companyId: string,
  userIds: Map<string, unknown>,
  syncedAt: string,
): Promise<CrmSyncCollectionStats> {
  const values = [...userIds.values()];
  let fetched = 0;
  let upserted = 0;
  const seen = new Set<string>();

  for (let i = 0; i < values.length; i += USER_ID_CHUNK) {
    const slice = values.slice(i, i + USER_ID_CHUNK);
    const docs = await session.db
      .collection('users')
      .find({ userId: { $in: slice } }, { batchSize: USER_ID_CHUNK })
      .toArray();

    const rows: Record<string, unknown>[] = [];
    for (const raw of docs) {
      fetched++;
      const row = toUserRow(raw as MongoDoc, companyId, syncedAt);
      if (!row) continue;
      if (seen.has(row.user_external_id)) continue;
      seen.add(row.user_external_id);
      rows.push(row as unknown as Record<string, unknown>);
      if (rows.length >= UPSERT_CHUNK) {
        upserted += await upsertUserRows(admin, rows.splice(0, rows.length));
      }
    }
    if (rows.length > 0) upserted += await upsertUserRows(admin, rows);
  }

  return { fetched, upserted };
}
