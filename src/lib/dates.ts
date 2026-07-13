// ─────────────────────────────────────────────────────────────────────────────
// Date formatting — single source of truth for user-facing date output.
//
// Before this module existed, the codebase had (at least) 4 different
// formatters: `toLocaleDateString('es-ES')` → "21/4/2026", `formatDateDMY`
// → "21/04/2026", a per-page `formatDateTime` that gave "21/04/2026 14:30",
// and a "21 abr 2026" style sprinkled around. That meant the same date
// could look different in two panels on the same page.
//
// Three canonical helpers are exported. ALL user-facing date rendering
// must go through one of these:
//
//   formatDate(d)         → "21/04/2026"            (numeric DMY — most tables)
//   formatDateTime(d)     → "21/04/2026 14:30"      (DMY + 24h time — audit rows, timestamps)
//   formatDateRelative(d) → "21 abr 2026"           (friendly, short-month — list views)
//
// All three accept the same input shape — `Date | string | null | undefined`
// — and return an empty string for nullish / invalid input so callers can
// render them directly without guards.
// ─────────────────────────────────────────────────────────────────────────────

type DateLike = Date | string | number | null | undefined;

function toDate(input: DateLike): Date | null {
  if (input == null || input === '') return null;
  let d: Date;
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    // BUG-06: una fecha-solo "YYYY-MM-DD" la parsea `new Date()` como
    // medianoche UTC; con getDate()/getMonth() (hora local) eso se corre al
    // día ANTERIOR en husos negativos (LatAm, UTC-5/-6) → "07/06" se veía
    // "06/06". Forzamos medianoche LOCAL para que la fecha del calendario se
    // muestre tal cual, sin importar el huso. (Los datetime con hora se
    // parsean normal y siguen mostrándose en hora local.)
    d = new Date(`${input}T00:00:00`);
  } else {
    d = input instanceof Date ? input : new Date(input);
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Numeric day-month-year: "21/04/2026".
 * Zero-padded so all rows align in tables.
 */
export function formatDate(input: DateLike): string {
  const d = toDate(input);
  if (!d) return '';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/**
 * Numeric DMY + 24h time: "21/04/2026 14:30".
 */
export function formatDateTime(input: DateLike): string {
  const d = toDate(input);
  if (!d) return '';
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Friendly short form with localised month: "21 abr 2026".
 * Uses `es` locale for month names.
 */
export function formatDateRelative(input: DateLike): string {
  const d = toDate(input);
  if (!d) return '';
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
}
