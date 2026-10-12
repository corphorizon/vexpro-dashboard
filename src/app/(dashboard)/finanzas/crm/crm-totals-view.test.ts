// Las reglas de celda de /finanzas/crm, fijadas al pasar la tabla a FinTable
// («Libro mayor», 2026-10-12): son las mismas comparaciones que había en el
// JSX, y ninguna puede convertir un «no lo sabemos» en un cero.
import { describe, it, expect } from 'vitest';
import { CRM_MONTHLY_METRICS } from '@/lib/crm-monthly';
import { crmDiff, detailNumber, isOutsideResult, lastComputedAt, reversalsShown } from './crm-totals-view';

describe('crmDiff', () => {
  it('falta un lado → sin comparación (nunca 0)', () => {
    expect(crmDiff(null, 100)).toEqual({ kind: 'unknown' });
    expect(crmDiff(100, null)).toEqual({ kind: 'unknown' });
    expect(crmDiff(null, null)).toEqual({ kind: 'unknown' });
  });

  it('debajo del centavo es redondeo, no diferencia', () => {
    expect(crmDiff(51409.65, 51409.65)).toEqual({ kind: 'match' });
    expect(crmDiff(100.004, 100)).toEqual({ kind: 'match' });
  });

  it('auto − manual con signo', () => {
    expect(crmDiff(5511.98, 5511)).toEqual({ kind: 'diff', value: 5511.98 - 5511 });
    expect(crmDiff(0, 99)).toEqual({ kind: 'diff', value: -99 });
  });

  it('un cero cargado contra un cero calculado coincide (0 es dato, no ausencia)', () => {
    expect(crmDiff(0, 0)).toEqual({ kind: 'match' });
  });
});

describe('detailNumber', () => {
  it('undefined / no numérico → null; 0 → 0', () => {
    expect(detailNumber(null, 'rewards')).toBeNull();
    expect(detailNumber({}, 'rewards')).toBeNull();
    expect(detailNumber({ rewards: '12' }, 'rewards')).toBeNull();
    expect(detailNumber({ rewards: Number.NaN }, 'rewards')).toBeNull();
    expect(detailNumber({ rewards: 0 }, 'rewards')).toBe(0);
    expect(detailNumber({ rewards: 12.5 }, 'rewards')).toBe(12.5);
  });
});

describe('reversalsShown', () => {
  it('sin reversos o en cero → «—» (null), como la tabla vieja', () => {
    expect(reversalsShown(null)).toBeNull();
    expect(reversalsShown({})).toBeNull();
    expect(reversalsShown({ reversals: 0 })).toBeNull();
    expect(reversalsShown({ reversals: 37.2 })).toBe(37.2);
  });
});

describe('isOutsideResult', () => {
  it('lo decide el registro: sólo ventas y retiros de prop firm alimentan el resultado', () => {
    const inside = CRM_MONTHLY_METRICS.filter((m) => !isOutsideResult(m)).map((m) => m.key);
    expect(inside.sort()).toEqual(['propfirm_sales', 'propfirm_withdrawals']);
  });

  it('toda métrica informativa queda fuera', () => {
    for (const m of CRM_MONTHLY_METRICS.filter((d) => d.informational)) {
      expect(isOutsideResult(m)).toBe(true);
    }
  });
});

describe('lastComputedAt', () => {
  it('el más reciente, ignorando nulos', () => {
    expect(
      lastComputedAt([
        { computedAt: '2026-10-01T03:00:00Z' },
        { computedAt: null },
        { computedAt: '2026-10-12T03:00:00Z' },
      ]),
    ).toBe('2026-10-12T03:00:00Z');
    expect(lastComputedAt([{ computedAt: null }])).toBeNull();
    expect(lastComputedAt([])).toBeNull();
  });
});
