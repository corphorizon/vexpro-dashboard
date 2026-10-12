// ─────────────────────────────────────────────────────────────────────────────
// Filtro por mes y saldo de cierre de los libritos de /liquidez e /inversiones.
//
// POR QUÉ EXISTE (2026-10-12, migración «Libro mayor» de las dos pantallas):
// las dos páginas tenían la MISMA lógica copiada a mano —agrupar por año/mes,
// filtrar por «YYYY-MM» y tomar el saldo corrido de la última fila— y ya
// divergían en los nombres. Una sola copia, con test, antes de que diverjan en
// el número.
//
// EL MES SALE DEL TEXTO, NO DE `new Date()`. Antes: `new Date('2026-09-01')`
// es medianoche UTC y `getMonth()` lo lee en la zona del navegador; en
// UTC-3 (Argentina) el 1 de septiembre caía en AGOSTO, el chip de septiembre
// no aparecía y el movimiento sumaba en el mes anterior. En Dubái (UTC+4,
// donde se probó) daba bien por casualidad — el mismo patrón que
// `mt5DateUtc()` corrigió en MT5 (reglas G4). `date` es `YYYY-MM-DD` en las
// dos tablas: el prefijo es el mes.
//
// DESCARTADO: parsear con `Date.UTC`. El prefijo es exacto, no depende de la
// zona y no hay nada que parsear.
// ─────────────────────────────────────────────────────────────────────────────

/** Filtro «todo el histórico». */
export const ALL_MONTHS = 'total';

/** «2026-09» a partir de «2026-09-01» (o de un ISO completo). null si no tiene forma de fecha. */
export function monthKeyOf(date: string | null | undefined): string | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})/.exec(date);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Años → meses (1-12) que tienen al menos una fila. */
export function monthsByYear(rows: Array<{ date: string }>): Map<number, Set<number>> {
  const map = new Map<number, Set<number>>();
  for (const r of rows) {
    const key = monthKeyOf(r.date);
    if (!key) continue;
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7));
    let set = map.get(year);
    if (!set) {
      set = new Set();
      map.set(year, set);
    }
    set.add(month);
  }
  return map;
}

/** Filas del mes `YYYY-MM`, o todas con `ALL_MONTHS`. */
export function filterByMonth<T extends { date: string }>(rows: T[], filter: string): T[] {
  if (filter === ALL_MONTHS) return rows;
  return rows.filter((r) => monthKeyOf(r.date) === filter);
}

/**
 * Saldo corrido al final de `rows` (la fila de fecha más tardía; a igual fecha,
 * la última en orden de llegada, igual que `useRunningBalance`).
 *
 * `null` si no hay filas: «sin movimientos» no es «saldo cero» (§1.3). Antes
 * las dos pantallas devolvían 0 y el KPI decía «$0.00» en una empresa vacía.
 */
export function closingBalance<T extends { id: string; date: string }>(
  rows: T[],
  balanceMap: Map<string, number>,
): number | null {
  if (rows.length === 0) return null;
  let last = rows[0];
  for (const r of rows) if (r.date.localeCompare(last.date) >= 0) last = r;
  const v = balanceMap.get(last.id);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
