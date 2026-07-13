import { describe, it, expect } from 'vitest';
import { computeDurationDistribution } from './duration-distribution';
import type { Trade } from './types';

// QA-01: bucketiza trades en 7 rangos de duración — terreno clásico de
// errores off-by-one en los límites de cada bucket.

const trade = (durationMinutes: number, profit = 0): Trade =>
  ({
    index: 0, position: 0, symbol: 'EURUSD', type: 'buy', volume: 1,
    openPrice: 1, closePrice: 1, sl: null, tp: null,
    openTime: new Date(0), closeTime: new Date(0),
    commission: 0, swap: 0, profit, durationMinutes,
  } as Trade);

const bucketCount = (trades: Trade[]) => {
  const d = computeDurationDistribution(trades);
  return Object.fromEntries(d.buckets.map((b) => [b.key, b.count]));
};

describe('computeDurationDistribution — límites de bucket (semi-abiertos [a, b))', () => {
  it('cada valor límite cae en el bucket correcto, sin doble conteo', () => {
    const c = bucketCount([
      trade(0.5),  // lt1
      trade(1),    // 1to2  (1 NO es lt1)
      trade(2),    // 2to3
      trade(3),    // 3to4
      trade(4),    // 4to5
      trade(5),    // 5to10 (5 NO es 4to5)
      trade(9.99), // 5to10
      trade(10),   // gt10  (10 NO es 5to10)
      trade(100),  // gt10
    ]);
    expect(c).toEqual({ lt1: 1, '1to2': 1, '2to3': 1, '3to4': 1, '4to5': 1, '5to10': 2, gt10: 2 });
  });

  it('el total = suma de trades válidos', () => {
    const d = computeDurationDistribution([trade(0.5), trade(5), trade(20)]);
    expect(d.totalCount).toBe(3);
    expect(d.buckets).toHaveLength(7); // siempre 7 filas aunque haya vacías
  });
});

describe('computeDurationDistribution — datos inválidos y profit', () => {
  it('omite NaN y duración negativa', () => {
    const d = computeDurationDistribution([trade(NaN), trade(-1), trade(2)]);
    expect(d.totalCount).toBe(1);
  });

  it('suma profit por bucket y total, redondeado a 2 decimales', () => {
    const d = computeDurationDistribution([trade(0.5, 10.1), trade(0.7, 5.05), trade(6, -3.33)]);
    const lt1 = d.buckets.find((b) => b.key === 'lt1')!;
    expect(lt1.profitTotal).toBeCloseTo(15.15, 2);
    expect(d.totalProfit).toBeCloseTo(11.82, 2);
  });

  it('lista vacía → todo en cero, 7 buckets', () => {
    const d = computeDurationDistribution([]);
    expect(d.totalCount).toBe(0);
    expect(d.totalProfit).toBe(0);
    expect(d.buckets).toHaveLength(7);
  });
});
