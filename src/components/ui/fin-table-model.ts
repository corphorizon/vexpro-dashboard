// ─────────────────────────────────────────────────────────────────────────────
// fin-table-model — las decisiones de FinTable que no son de dibujo, puras
// para testearlas sin DOM: agrupar con subtotales, contar lo que falta, y
// ubicar cada columna en la tarjeta móvil.
//
// Subtotales (spec §5.3 «fila de grupo con conteo y subtotal»):
//   · Suma sólo números finitos. Un null NO es 0: se cuenta en `missing` y la
//     fila de grupo lo dice («Pasarelas · 4 · 1 sin dato»). Si TODOS son null
//     el subtotal es null («—»), nunca $0.00 (reglas-del-proyecto.md §1.3).
//   · Si la tabla está RECORTADA (se muestran N de M), el subtotal de las N
//     filas visibles sería un número plausible y equivocado: se marca
//     `partial` y la UI muestra «—» con el porqué, salvo que el llamador pase
//     los subtotales reales (calculados sobre las M).
//
// Tarjeta móvil (< 720 px, spec §5.3): grilla de 2 columnas. Izquierda: la
// columna de nombre y las de texto; derecha: dinero y números. Cada celda
// lleva fila explícita (gridRow) — el auto-placement con columna fija apila
// mal cuando las dos columnas tienen distinta cantidad de celdas.
// ─────────────────────────────────────────────────────────────────────────────

export interface SumColumn<R> {
  key: string;
  value: (row: R) => number | null | undefined;
}

export interface Subtotal {
  /** Suma de los valores conocidos; null si no hay ninguno o si es parcial. */
  sum: number | null;
  /** Filas con valor null/NaN en esta columna. */
  missing: number;
  /** La tabla está recortada: la suma de lo visible no es el subtotal real. */
  partial: boolean;
}

export interface RowGroup<R> {
  key: string;
  rows: R[];
  subtotals: Record<string, Subtotal>;
  /** Filas del grupo con AL MENOS un valor faltante en las columnas sumadas. */
  missingRows: number;
}

export function subtotal<R>(rows: R[], value: (row: R) => number | null | undefined, partial = false): Subtotal {
  let sum = 0;
  let known = 0;
  let missing = 0;
  for (const r of rows) {
    const v = value(r);
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      known += 1;
    } else {
      missing += 1;
    }
  }
  return { sum: partial || known === 0 ? null : Math.round(sum * 100) / 100, missing, partial };
}

/**
 * Agrupa en orden de primera aparición (el orden de las filas manda: si
 * vienen ordenadas por grupo, quedan igual). `partial` = la tabla está recortada.
 */
export function groupRows<R>(
  rows: R[],
  groupBy: (row: R) => string,
  sumColumns: SumColumn<R>[],
  partial = false,
): RowGroup<R>[] {
  const order: string[] = [];
  const byKey = new Map<string, R[]>();
  for (const r of rows) {
    const k = groupBy(r);
    let bucket = byKey.get(k);
    if (!bucket) {
      bucket = [];
      byKey.set(k, bucket);
      order.push(k);
    }
    bucket.push(r);
  }
  return order.map((key) => {
    const groupRowsList = byKey.get(key)!;
    const subtotals: Record<string, Subtotal> = {};
    for (const c of sumColumns) subtotals[c.key] = subtotal(groupRowsList, c.value, partial);
    const missingRows = groupRowsList.filter((r) =>
      sumColumns.some((c) => {
        const v = c.value(r);
        return !(typeof v === 'number' && Number.isFinite(v));
      }),
    ).length;
    return { key, rows: groupRowsList, subtotals, missingRows };
  });
}

/** ¿La tabla está recortada? Sólo si el total conocido supera lo mostrado. */
export function isTruncated(shown: number, totalCount: number | null | undefined): boolean {
  return typeof totalCount === 'number' && Number.isFinite(totalCount) && totalCount > shown;
}

export interface CardColumnInput {
  key: string;
  kind?: 'text' | 'money' | 'number';
  hideSm?: boolean;
  cardSide?: 'left' | 'right';
}

export interface CardPlacement {
  /** 'hidden' = no se muestra en la tarjeta (hideSm). */
  side: 'left' | 'right' | 'hidden';
  /** Fila 1-based dentro de la tarjeta. 0 si hidden. */
  row: number;
}

export function cardLayout(columns: CardColumnInput[]): Record<string, CardPlacement> {
  const out: Record<string, CardPlacement> = {};
  let left = 0;
  let right = 0;
  for (const c of columns) {
    if (c.hideSm) {
      out[c.key] = { side: 'hidden', row: 0 };
      continue;
    }
    const side = c.cardSide ?? (c.kind === 'money' || c.kind === 'number' ? 'right' : 'left');
    out[c.key] = side === 'left' ? { side, row: ++left } : { side, row: ++right };
  }
  return out;
}
