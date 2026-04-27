import type { Trade } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Duration Distribution
//
// Buckets de duración fijos (en minutos):
//   <1, 1-2, 2-3, 3-4, 4-5, 5-10, >10
//
// Reglas de pertenencia (para evitar trades en doble bucket):
//   <1   →  d < 1
//   1-2  →  1 ≤ d < 2
//   2-3  →  2 ≤ d < 3
//   3-4  →  3 ≤ d < 4
//   4-5  →  4 ≤ d < 5
//   5-10 →  5 ≤ d < 10
//   >10  →  d ≥ 10
//
// Trades con `durationMinutes` NaN o negativo se omiten silenciosamente
// (ya que el parser puede dejar NaN si openTime/closeTime no son válidos).
// ─────────────────────────────────────────────────────────────────────────────

export type DurationRangeKey = 'lt1' | '1to2' | '2to3' | '3to4' | '4to5' | '5to10' | 'gt10';

export interface DurationBucket {
  key: DurationRangeKey;
  label: string;       // "<1 min", "1-2 min", etc.
  count: number;
  profitTotal: number; // suma de profit (puede ser negativa)
  trades: Trade[];     // los trades incluidos en este bucket (para el modal)
}

export interface DurationDistribution {
  buckets: DurationBucket[];
  totalCount: number;
  totalProfit: number;
}

const BUCKET_DEFINITIONS: { key: DurationRangeKey; label: string; predicate: (d: number) => boolean }[] = [
  { key: 'lt1',   label: '<1 min',   predicate: (d) => d < 1 },
  { key: '1to2',  label: '1-2 min',  predicate: (d) => d >= 1 && d < 2 },
  { key: '2to3',  label: '2-3 min',  predicate: (d) => d >= 2 && d < 3 },
  { key: '3to4',  label: '3-4 min',  predicate: (d) => d >= 3 && d < 4 },
  { key: '4to5',  label: '4-5 min',  predicate: (d) => d >= 4 && d < 5 },
  { key: '5to10', label: '5-10 min', predicate: (d) => d >= 5 && d < 10 },
  { key: 'gt10',  label: '>10 min',  predicate: (d) => d >= 10 },
];

export function computeDurationDistribution(trades: Trade[]): DurationDistribution {
  // Inicializar todos los buckets con valores 0/[] para que siempre rendericen
  // las 7 filas, aún si algún rango quedó vacío.
  const buckets: DurationBucket[] = BUCKET_DEFINITIONS.map(({ key, label }) => ({
    key, label, count: 0, profitTotal: 0, trades: [],
  }));

  let totalCount = 0;
  let totalProfit = 0;

  for (const trade of trades) {
    const d = trade.durationMinutes;
    if (typeof d !== 'number' || Number.isNaN(d) || d < 0) continue;

    const bucketDef = BUCKET_DEFINITIONS.find((b) => b.predicate(d));
    if (!bucketDef) continue;

    const bucket = buckets.find((b) => b.key === bucketDef.key)!;
    bucket.count += 1;
    bucket.profitTotal += trade.profit;
    bucket.trades.push(trade);

    totalCount += 1;
    totalProfit += trade.profit;
  }

  // Round profit totals to 2 decimals para evitar errores de float visibles
  for (const b of buckets) {
    b.profitTotal = Math.round(b.profitTotal * 100) / 100;
  }
  totalProfit = Math.round(totalProfit * 100) / 100;

  return { buckets, totalCount, totalProfit };
}
