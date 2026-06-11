import { describe, it, expect } from 'vitest';
import {
  calculateCommission,
  calculateSalaryFromND,
  calculateHeadSalaryFromND,
  calculateBdmPctFromND,
  calculateHeadDifferential,
  calculatePnlSpecial,
  getPreviousPeriod,
  SALARY_TIERS,
  HEAD_SALARY_TIERS,
  BDM_PCT_TIERS,
} from './commission-calculator';
import type { Period } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Tests del núcleo de cálculo de comisiones. Estos protegen la PLATA — un
// error acá paga de más/de menos a la fuerza comercial. Cubren la fórmula
// estándar (ND/2 + acumulado × pct), los tiers de salario/porcentaje (que
// NO deben tener gaps ni solapamientos), el diferencial de HEAD, y el modo
// PnL Especial (que debe estar aislado del normal, sin acumulado).
// ─────────────────────────────────────────────────────────────────────────────

describe('calculateCommission (fórmula estándar PnL normal)', () => {
  it('ND=0 devuelve todo en cero (no paga ni acumula)', () => {
    const r = calculateCommission(0, 5000, 5);
    expect(r.division).toBe(0);
    expect(r.commission).toBe(0);
    expect(r.realPayment).toBe(0);
    expect(r.accumulatedOut).toBe(0);
  });

  it('división = ND/2 y comisión = (división + acumulado) × pct', () => {
    // ND 100k, acumulado previo 0, 5% → división 50k, comisión 2500
    const r = calculateCommission(100_000, 0, 5);
    expect(r.division).toBe(50_000);
    expect(r.commission).toBe(2_500);
    expect(r.realPayment).toBe(2_500);
    expect(r.accumulatedOut).toBe(50_000); // la división se arrastra
  });

  it('suma el acumulado previo a la base antes de aplicar el pct', () => {
    // ND 100k → división 50k; + acumulado 10k = 60k × 5% = 3000
    const r = calculateCommission(100_000, 10_000, 5);
    expect(r.commission).toBe(3_000);
  });

  it('ND negativo produce división y acumulado negativos (deuda)', () => {
    // ND -40k → división -20k; comisión (−20k + 0) × 5% = −1000
    const r = calculateCommission(-40_000, 0, 5);
    expect(r.division).toBe(-20_000);
    expect(r.commission).toBe(-1_000);
    expect(r.accumulatedOut).toBe(-20_000); // arrastra la deuda al mes siguiente
  });

  it('redondea a 2 decimales', () => {
    // ND 33333 → división 16666.5 × 3% = 499.995 → 500.00 (round2)
    const r = calculateCommission(33_333, 0, 3);
    expect(r.division).toBe(16_666.5);
    expect(Number.isInteger(r.commission * 100)).toBe(true); // máx 2 decimales
  });
});

describe('Salary tiers (BDM) — sin gaps ni solapamientos', () => {
  it('respeta cada umbral exacto', () => {
    expect(calculateSalaryFromND(200_000)).toBe(2_000);
    expect(calculateSalaryFromND(100_000)).toBe(1_000);
    expect(calculateSalaryFromND(50_000)).toBe(500);
  });

  it('justo debajo de un umbral cae al tier inferior', () => {
    expect(calculateSalaryFromND(199_999)).toBe(1_000);
    expect(calculateSalaryFromND(99_999)).toBe(500);
    expect(calculateSalaryFromND(49_999)).toBe(0);
  });

  it('ND negativo → salario 0', () => {
    expect(calculateSalaryFromND(-300_000)).toBe(0);
  });

  it('los tiers están ordenados descendente (invariante del algoritmo)', () => {
    for (let i = 1; i < SALARY_TIERS.length; i++) {
      expect(SALARY_TIERS[i].minND).toBeLessThan(SALARY_TIERS[i - 1].minND);
    }
  });
});

describe('Salary tiers (HEAD) — team total ND', () => {
  it('respeta los 5 umbrales', () => {
    expect(calculateHeadSalaryFromND(500_000)).toBe(5_000);
    expect(calculateHeadSalaryFromND(400_000)).toBe(4_000);
    expect(calculateHeadSalaryFromND(300_000)).toBe(3_000);
    expect(calculateHeadSalaryFromND(200_000)).toBe(2_000);
    expect(calculateHeadSalaryFromND(100_000)).toBe(1_000);
  });

  it('debajo del piso → 0', () => {
    expect(calculateHeadSalaryFromND(99_999)).toBe(0);
  });

  it('ordenados descendente', () => {
    for (let i = 1; i < HEAD_SALARY_TIERS.length; i++) {
      expect(HEAD_SALARY_TIERS[i].minND).toBeLessThan(HEAD_SALARY_TIERS[i - 1].minND);
    }
  });
});

describe('BDM percentage tiers', () => {
  it('respeta los umbrales de %', () => {
    expect(calculateBdmPctFromND(200_000)).toBe(6);
    expect(calculateBdmPctFromND(100_000)).toBe(5);
    expect(calculateBdmPctFromND(50_000)).toBe(4);
  });

  it('debajo de $50k usa el % del perfil (fallback)', () => {
    expect(calculateBdmPctFromND(40_000, 3.5)).toBe(3.5);
    expect(calculateBdmPctFromND(40_000)).toBe(0); // sin perfil → 0
  });

  it('ND negativo usa el % del perfil', () => {
    expect(calculateBdmPctFromND(-10_000, 2)).toBe(2);
  });

  it('tiers ordenados descendente', () => {
    for (let i = 1; i < BDM_PCT_TIERS.length; i++) {
      expect(BDM_PCT_TIERS[i].minND).toBeLessThan(BDM_PCT_TIERS[i - 1].minND);
    }
  });
});

describe('calculateHeadDifferential', () => {
  it('diff = (head_pct − bdm_pct) + extra, aplicado sobre la división del BDM', () => {
    // HEAD 7%, BDM 4%, extra 0% → diff 3%. BDM ND 100k → división 50k.
    // comisión = (50k + 0) × 3% = 1500
    const r = calculateHeadDifferential(7, 0, [
      { profileId: 'b1', name: 'BDM1', netDepositCurrent: 100_000, accumulatedIn: 0, commissionPct: 4 },
    ]);
    expect(r.details[0].diffPct).toBe(3);
    expect(r.details[0].commission).toBe(1_500);
    expect(r.totalDifferential).toBe(1_500);
  });

  it('realPayment del diferencial se clampea a 0 (no paga diferencial negativo)', () => {
    // BDM ND negativo → comisión negativa, pero realPayment = max(0, ...)
    const r = calculateHeadDifferential(7, 0, [
      { profileId: 'b1', name: 'BDM1', netDepositCurrent: -100_000, accumulatedIn: 0, commissionPct: 4 },
    ]);
    expect(r.details[0].commission).toBeLessThan(0);
    expect(r.details[0].realPayment).toBe(0);
    expect(r.totalRealPayment).toBe(0);
  });

  it('suma el diferencial de varios BDMs', () => {
    const r = calculateHeadDifferential(6, 1, [
      { profileId: 'b1', name: 'BDM1', netDepositCurrent: 100_000, accumulatedIn: 0, commissionPct: 4 },
      { profileId: 'b2', name: 'BDM2', netDepositCurrent: 200_000, accumulatedIn: 0, commissionPct: 5 },
    ]);
    // BDM1: diff (6−4)+1=3% sobre división 50k = 1500
    // BDM2: diff (6−5)+1=2% sobre división 100k = 2000
    expect(r.totalDifferential).toBe(3_500);
  });
});

describe('calculatePnlSpecial (modo Especial — aislado del normal)', () => {
  it('comisión = pnl × pct SIN dividir entre 2 ni acumular', () => {
    const r = calculatePnlSpecial(10_000, 35, 0);
    expect(r.commission).toBe(3_500); // 10k × 35%, no 10k/2 × 35%
    expect(r.accumulatedOut).toBe(0); // NUNCA acumula
  });

  it('resta las comisiones de lotes del pago real', () => {
    const r = calculatePnlSpecial(10_000, 35, 1_000);
    expect(r.commission).toBe(3_500);
    expect(r.realPayment).toBe(2_500); // 3500 − 1000
  });

  it('accumulatedOut siempre 0 — no arrastra deuda al mes siguiente', () => {
    // Aunque el PnL sea negativo, el modo Especial no arrastra nada.
    const r = calculatePnlSpecial(-5_000, 35, 0);
    expect(r.accumulatedOut).toBe(0);
    expect(r.commission).toBe(-1_750);
  });

  it('preserva el salario fijo sin aplicar tiers', () => {
    const r = calculatePnlSpecial(10_000, 35, 0, 800);
    expect(r.salary).toBe(800);
  });
});

describe('getPreviousPeriod (orden cronológico)', () => {
  const periods: Period[] = [
    { id: 'mar', company_id: 'c', year: 2026, month: 3, label: 'Mar 26', is_closed: true, reserve_pct: 0.1 },
    { id: 'may', company_id: 'c', year: 2026, month: 5, label: 'May 26', is_closed: false, reserve_pct: 0.1 },
    { id: 'apr', company_id: 'c', year: 2026, month: 4, label: 'Abr 26', is_closed: false, reserve_pct: 0.1 },
  ];

  it('devuelve el período inmediatamente anterior aunque la lista esté desordenada', () => {
    expect(getPreviousPeriod(periods, 'may')?.id).toBe('apr');
    expect(getPreviousPeriod(periods, 'apr')?.id).toBe('mar');
  });

  it('devuelve null para el primer período', () => {
    expect(getPreviousPeriod(periods, 'mar')).toBeNull();
  });

  it('cruza el límite de año correctamente', () => {
    const cross: Period[] = [
      { id: 'dec25', company_id: 'c', year: 2025, month: 12, label: 'Dic 25', is_closed: true, reserve_pct: 0.1 },
      { id: 'jan26', company_id: 'c', year: 2026, month: 1, label: 'Ene 26', is_closed: false, reserve_pct: 0.1 },
    ];
    expect(getPreviousPeriod(cross, 'jan26')?.id).toBe('dec25');
  });
});
