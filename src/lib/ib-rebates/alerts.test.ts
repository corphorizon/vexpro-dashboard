import { describe, it, expect } from 'vitest';
import { computeAlert } from './alerts';
import { DEFAULT_THRESHOLDS } from './types';
import type { IbRebateConfig, IbRebateThresholds } from './types';

// QA-01: umbrales de alerta sobre rebates de IB (dinero a pagar a socios).
// La lógica de umbral es exactamente lo que se rompe al ajustar constantes.

const DAY = 1000 * 60 * 60 * 24;
const th: IbRebateThresholds = { company_id: 'c', ...DEFAULT_THRESHOLDS }; // 60/90 · 30/60/90

// last_update_date = exactamente N días atrás → daysSince === N.
const cfg = (daysAgo: number, changeType: IbRebateConfig['last_change_type']): IbRebateConfig =>
  ({
    id: 'x', company_id: 'c', username: 'ib1', archivo: null,
    config_date: '2026-01-01', original_config_date: '2026-01-01',
    last_update_date: new Date(Date.now() - daysAgo * DAY).toISOString(),
    stp: 0, ecn: 0, goals_met: false, last_change_type: changeType,
  } as IbRebateConfig);

describe('computeAlert — modo inicial (null / edit → 60/90)', () => {
  it('verde antes del umbral amarillo', () => {
    const r = computeAlert(cfg(59, null), th);
    expect(r.level).toBe('green');
    expect(r.mode).toBe('initial');
    expect(r.daysSince).toBe(59);
  });
  it('amarillo en el umbral (60)', () => {
    expect(computeAlert(cfg(60, null), th).level).toBe('yellow');
    expect(computeAlert(cfg(89, 'edit'), th).level).toBe('yellow');
  });
  it('rojo en/after 90', () => {
    expect(computeAlert(cfg(90, null), th).level).toBe('red');
    expect(computeAlert(cfg(200, 'edit'), th).level).toBe('red');
  });
});

describe('computeAlert — modo recurrente (upgrade/downgrade → 30/60/90)', () => {
  it('upgrade y downgrade activan modo recurrente', () => {
    expect(computeAlert(cfg(10, 'upgrade'), th).mode).toBe('recurring');
    expect(computeAlert(cfg(10, 'downgrade'), th).mode).toBe('recurring');
  });
  it('verde <30, amarillo [30,60), naranja [60,90), rojo ≥90', () => {
    expect(computeAlert(cfg(29, 'upgrade'), th).level).toBe('green');
    expect(computeAlert(cfg(30, 'upgrade'), th).level).toBe('yellow');
    expect(computeAlert(cfg(60, 'upgrade'), th).level).toBe('orange');
    expect(computeAlert(cfg(90, 'downgrade'), th).level).toBe('red');
  });
});

describe('computeAlert — robustez', () => {
  it('daysSince nunca negativo (fecha futura → 0, verde)', () => {
    const r = computeAlert(cfg(-5, null), th);
    expect(r.daysSince).toBe(0);
    expect(r.level).toBe('green');
  });
});
