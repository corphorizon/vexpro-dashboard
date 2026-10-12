// Barra de distribución: base = positivos, máx. 5 + Otros, % que suman 100,
// exclusiones contadas, colores de la rampa de marca (nunca pos/neg/pend).
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { computeDistribution, roundToHundred, OTHERS_KEY } from './distribution';
import { DistributionBar, segmentColor, DIST_RAMP } from './distribution-bar';
import { html } from '@/test/render';

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 10) / 10;

describe('roundToHundred', () => {
  it('los % suman exactamente 100.0', () => {
    expect(sum(roundToHundred([1, 1, 1]))).toBe(100);
    expect(roundToHundred([1, 1, 1])).toEqual([33.4, 33.3, 33.3]);
    expect(sum(roundToHundred([48210.55, 12904.1, 3120, 61480.02, 940.5, 22005]))).toBe(100);
  });
  it('total 0 → todos 0 (no divide por cero)', () => {
    expect(roundToHundred([0, 0])).toEqual([0, 0]);
  });
});

describe('computeDistribution', () => {
  it('deudas, ceros y null NO entran, y se cuentan', () => {
    const d = computeDistribution([
      { key: 'a', label: 'A', value: 100 },
      { key: 'debt', label: 'Deuda', value: -40 },
      { key: 'zero', label: 'Cero', value: 0 },
      { key: 'nul', label: 'Sin dato', value: null },
    ]);
    expect(d.total).toBe(100);
    expect(d.segments.map((s) => s.key)).toEqual(['a']);
    expect(d.excludedCount).toBe(2);
    expect(d.excludedTotal).toBe(-40);
    expect(d.missingCount).toBe(1);
  });

  it('máximo 5 con nombre + «Otros», ordenados de mayor a menor', () => {
    const items = [10, 20, 30, 40, 50, 60, 70].map((v, i) => ({ key: `k${i}`, label: `K${i}`, value: v }));
    const d = computeDistribution(items, 'Otros');
    expect(d.segments).toHaveLength(6);
    expect(d.segments.slice(0, 5).map((s) => s.value)).toEqual([70, 60, 50, 40, 30]);
    const others = d.segments[5];
    expect(others.key).toBe(OTHERS_KEY);
    expect(others.others).toBe(true);
    expect(others.value).toBe(30);
    expect(others.count).toBe(2);
    expect(sum(d.segments.map((s) => s.pct))).toBe(100);
  });

  it('lo < 2 % va a «Otros» aunque haya lugar', () => {
    const d = computeDistribution([
      { key: 'big', label: 'Big', value: 1000 },
      { key: 's1', label: 'S1', value: 5 },
      { key: 's2', label: 'S2', value: 5 },
    ]);
    expect(d.segments.map((s) => s.key)).toEqual(['big', OTHERS_KEY]);
  });

  it('un «Otros» de UN solo ítem se muestra con nombre si hay lugar', () => {
    const d = computeDistribution([
      { key: 'big', label: 'Big', value: 1000 },
      { key: 'tiny', label: 'Tiny', value: 1 },
    ]);
    expect(d.segments.map((s) => s.key)).toEqual(['big', 'tiny']);
  });

  it('stale se hereda al segmento (y a «Otros» si contiene uno)', () => {
    const d = computeDistribution([
      { key: 'a', label: 'A', value: 1000, stale: true },
      { key: 's1', label: 'S1', value: 1, stale: true },
      { key: 's2', label: 'S2', value: 1 },
    ]);
    expect(d.segments[0].stale).toBe(true);
    expect(d.segments[1].others && d.segments[1].stale).toBe(true);
  });
});

describe('segmentColor', () => {
  it('rampa de brand-ink al 100/75/55/40/28 %; «Otros» en border-strong', () => {
    expect(DIST_RAMP).toEqual([100, 75, 55, 40, 28]);
    expect(segmentColor({ others: false, rank: 0 })).toBe('var(--brand-ink)');
    expect(segmentColor({ others: false, rank: 1 })).toContain('var(--brand-ink) 75%');
    expect(segmentColor({ others: false, rank: 4 })).toContain('var(--brand-ink) 28%');
    expect(segmentColor({ others: true, rank: 5 })).toBe('var(--border-strong)');
  });
  it('nunca usa colores con significado (pos/neg/pend)', () => {
    for (let r = 0; r < 6; r++) {
      expect(segmentColor({ others: false, rank: r })).not.toMatch(/--(pos|neg|pend|warning|positive|negative)/);
    }
  });
});

describe('<DistributionBar>', () => {
  it('role=img con aria-label que enumera los %, y leyenda con nombre + %', () => {
    const out = html(
      createElement(DistributionBar, {
        items: [
          { key: 'a', label: 'Binance', value: 75 },
          { key: 'b', label: 'Coinsbuy', value: 25 },
          { key: 'd', label: 'Deuda', value: -10 },
        ],
      }),
    );
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="Distribución: Binance 75.0 %, Coinsbuy 25.0 %"');
    expect(out).toContain('title="Binance: $75.00 (75.0 %)"');
    // La exclusión se dice, con el monto.
    expect(out).toContain('No incluye 1 saldos negativos o en cero (-$10.00)');
  });

  it('sin positivos: lo dice, no dibuja una barra vacía', () => {
    const out = html(createElement(DistributionBar, { items: [{ key: 'a', label: 'A', value: null }] }));
    expect(out).not.toContain('role="img"');
    expect(out).toContain('Sin saldos positivos para distribuir');
    expect(out).toContain('1 sin dato');
  });
});
