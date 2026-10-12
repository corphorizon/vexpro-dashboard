// ─────────────────────────────────────────────────────────────────────────────
// Lo que /finanzas/crm decide sobre cada celda, sacado del JSX para poder
// fijarlo con tests (migración «Libro mayor», 2026-10-12).
//
// POR QUÉ: la tabla vieja decidía en línea si la diferencia era «—», «$0.00»
// o un monto, y si un reverso en 0 era «—». Al pasar a FinTable esas reglas
// cambian de lugar; si se mueven a ojo, un `null` (no lo sabemos) termina
// pintado como cero, que es justo el fallo que la pantalla existe para evitar
// (reglas-del-proyecto.md §1.3). Acá no hay ningún cálculo nuevo: son las
// mismas comparaciones de antes, con nombre.
//
// DESCARTADO: un total de la columna «Del CRM» en el pie de la tabla. La
// pantalla nunca lo tuvo, y sumar meses abiertos con cerrados daría una cifra
// que nadie concilia contra nada.
// ─────────────────────────────────────────────────────────────────────────────

import type { CrmMonthlyMetricDef } from '@/lib/crm-monthly';

/** Debajo del centavo es redondeo, no una diferencia. */
export const CRM_DIFF_EPSILON = 0.009;

export type CrmDiff =
  /** Falta uno de los dos lados: no hay comparación posible («—»). */
  | { kind: 'unknown' }
  /** Coinciden (o difieren por redondeo): se muestra $0.00 en gris. */
  | { kind: 'match' }
  /** Difieren: el monto va en `neg`, es lo que hay que revisar. */
  | { kind: 'diff'; value: number };

/** auto − manual, con la misma regla que tenía la tabla. `null` de un lado = sin comparación. */
export function crmDiff(auto: number | null, manual: number | null): CrmDiff {
  if (auto === null || manual === null) return { kind: 'unknown' };
  const value = auto - manual;
  if (Math.abs(value) < CRM_DIFF_EPSILON) return { kind: 'match' };
  return { kind: 'diff', value };
}

/**
 * Valor numérico de `detail[key]`. `undefined` (la fila se calculó antes de
 * que la serie existiera) o cualquier cosa que no sea número → `null` («—»).
 * Un `0` sí es un cero real y se devuelve tal cual.
 */
export function detailNumber(detail: Record<string, unknown> | null, key: string): number | null {
  const v = detail?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Reversos del mes. La tabla vieja mostraba «—» tanto para «la métrica no
 * tiene reversos» (`undefined`) como para «no hubo» (0): un reverso en cero no
 * es noticia y la columna existe para contrastar, no para sumar.
 */
export function reversalsShown(detail: Record<string, unknown> | null): number | null {
  const n = detailNumber(detail, 'reversals');
  return n === null || n === 0 ? null : n;
}

/**
 * ¿La métrica queda FUERA del resultado? Lo dice el registro (`feedsResult`),
 * no una lista en la pantalla: hoy las informativas y también P2P, que se
 * compara contra un manual pero no suma a ningún total.
 */
export function isOutsideResult(def: Pick<CrmMonthlyMetricDef, 'feedsResult'>): boolean {
  return !def.feedsResult;
}

/** El cálculo más reciente entre las filas (ISO ordena como fecha). `null` si ninguna lo tiene. */
export function lastComputedAt(rows: ReadonlyArray<{ computedAt: string | null }>): string | null {
  let last: string | null = null;
  for (const r of rows) {
    if (r.computedAt && (last === null || r.computedAt > last)) last = r.computedAt;
  }
  return last;
}
