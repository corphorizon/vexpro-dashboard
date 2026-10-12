// ─────────────────────────────────────────────────────────────────────────────
// logs-view — decisiones puras de /logs («Libro mayor», 2026-10-12).
//
// POR QUÉ un archivo aparte: la pantalla tenía tres fallos que no daban error,
// y los tres son decisiones que se pueden testear sin React:
//   1. Si /api/admin/audit-log fallaba (500, red, `success: false`), la tabla
//      quedaba vacía y decía «Sin actividad · ningún registro coincide» — un
//      auditor leía «nadie hizo nada hoy» cuando en realidad no sabíamos.
//      Ahora el estado de carga distingue `error` de `ok` con 0 filas.
//   2. El CSV paginaba de a 200 hasta 50 páginas y, si una página fallaba a
//      mitad de camino, `json.entries ?? []` daba un lote vacío, el bucle
//      cortaba y se descargaba un CSV PARCIAL con cara de completo. Ahora una
//      falla no descarga nada y el tope (10.000) se avisa con números.
//   3. La paginación se mostraba como «1–50 de 900» en gris chico; el pie del
//      panel ahora lo dice como recorte («Mostrando 1–50 de 900 · página 1
//      de 18»): un listado paginado es un recorte y se cuenta (reglas §1.2).
//
// Color de la acción (spec §2.1: el color es significado, nunca decoración):
// sólo `delete` lleva color (`bad`): es lo único que destruye datos y lo
// primero que busca quien audita. Antes create=verde, update=ámbar,
// delete=rojo: «actualizó un egreso» no es un pendiente ni un aviso, y el
// verde de «creó» no significa ganancia. Todo lo demás va en gris.
// DESCARTADO: `pend` para `update` (no requiere acción de nadie) e `info` para
// login/logout (no es una fuente automática; sería color decorativo).
// ─────────────────────────────────────────────────────────────────────────────
import type { StatusKind } from '@/components/ui/status-kind';

export const LOGS_PAGE_SIZE = 50;
/** Lote del export CSV (el tope de la API es 200 por página). */
export const EXPORT_BATCH = 200;
/** Tope de páginas del export: 50 × 200 = 10.000 filas, para no colgar el navegador. */
export const EXPORT_MAX_PAGES = 50;

export function auditActionKind(action: string): StatusKind {
  return action === 'delete' ? 'bad' : 'neutral';
}

export function totalPages(total: number, pageSize = LOGS_PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** Rango visible de la página («51–100»). null si no hay filas. */
export function pageRange(
  page: number,
  total: number,
  pageSize = LOGS_PAGE_SIZE,
): { from: number; to: number } | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const from = (page - 1) * pageSize + 1;
  if (from > total) return null;
  return { from, to: Math.min(page * pageSize, total) };
}

/** Respuesta del GET de la API, validada. `null` = la carga falló (no es «0 filas»). */
export interface AuditLogPage<R> {
  entries: R[];
  total: number;
  facets: { modules: string[]; actions: string[]; users: string[] };
}

export function parseAuditLogResponse<R>(ok: boolean, json: unknown): AuditLogPage<R> | null {
  if (!ok || json == null || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  if (j.success !== true || !Array.isArray(j.entries)) return null;
  // `total` ausente o no numérico: no inventamos un 0 (con 50 filas en
  // pantalla, «0 en total» sería falso). Tomamos lo que vino.
  const total = typeof j.total === 'number' && Number.isFinite(j.total) ? j.total : j.entries.length;
  const f = (j.facets ?? {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    entries: j.entries as R[],
    total,
    facets: { modules: arr(f.modules), actions: arr(f.actions), users: arr(f.users) },
  };
}

/**
 * Qué pasó con el export. `failed` = una página no respondió: NO se descarga
 * (un CSV parcial sin aviso es el bug que esto corrige). `capped` = se llegó al
 * tope de páginas con más filas por traer: se descarga y se avisa N de M.
 */
export type ExportOutcome =
  | { kind: 'complete'; rows: number }
  | { kind: 'capped'; rows: number; total: number }
  | { kind: 'failed'; rows: number; total: number | null };

export function exportOutcome(fetched: number, total: number | null, failed: boolean): ExportOutcome {
  if (failed) return { kind: 'failed', rows: fetched, total };
  if (total != null && fetched < total) return { kind: 'capped', rows: fetched, total };
  return { kind: 'complete', rows: fetched };
}
