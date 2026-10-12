// ─────────────────────────────────────────────────────────────────────────────
// /finanzas/reportes — las comparaciones de los KPIs, fuera del JSX.
//
// POR QUÉ (2026-10-12, migración «Libro mayor»): la página tenía tres copias
// en línea de «% del mes actual» (depósito neto, P&L broker, P&L prop firm),
// cada una con su propia guarda contra el null y el cero. Al pasar a
// `KpiStrip` (que recibe `delta` como número) se juntan acá, con test, sin
// cambiar ninguna regla: `null` de un lado = sin comparación, nunca «−100 %».
// `pctVariation` se movió tal cual desde page.tsx.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Variación porcentual contra el mes anterior.
 * `null` de cualquier lado = sin comparación posible. Antes los parámetros eran
 * `number` porque el builder colapsaba los nulos a 0 con un `?? 0`: comparar
 * contra un cero inventado daba «−100%» con toda la cara de un dato real.
 */
export function pctVariation(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !previous) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** «El rango es el X % del mes». Sin mes (null o 0) o sin rango → sin referencia. */
export function pctOfMonth(range: number | null, month: number | null): number | null {
  if (range === null || month === null || !month) return null;
  return (range / Math.abs(month)) * 100;
}

/** Un decimal, como mostraba la pantalla («12.3»). */
export function roundPct(pct: number): string {
  return String(Math.round(pct * 10) / 10);
}

/** Fuente de un saldo por canal → etiqueta de fuente: lo automático va como API (`info`). */
export function channelSourceKind(type: string): 'api' | 'manual' {
  return type === 'manual' ? 'manual' : 'api';
}

/**
 * Saldo de un canal tal como se PINTA. `source: 'missing'` viene del builder
 * con `amount: 0` (balances-by-channel.ts, mejora C8): ese cero no es una
 * wallet vacía, es «no hay dato» — se muestra «—». El total del endpoint no
 * cambia (ese canal ya suma 0); la pantalla dice que no está sumado.
 */
export function channelAmount(row: { amount: number; source: string }): number | null {
  return row.source === 'missing' ? null : row.amount;
}

/** Nombres de los canales sin dato, para el aviso. */
export function missingChannelLabels(rows: ReadonlyArray<{ label: string; source: string }>): string[] {
  return rows.filter((r) => r.source === 'missing').map((r) => r.label);
}
