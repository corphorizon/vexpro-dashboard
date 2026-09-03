import { describe, it, expect } from 'vitest';
import {
  calculateCommission,
  calculateSalaryFromND,
  calculateHeadSalaryFromND,
  calculateBdmPctFromND,
  calculateHeadDifferential,
  calculatePnlSpecial,
  calcularPasoPnlEncadenado,
  applyTotalEarnedDebt,
  getPreviousPeriod,
  SALARY_TIERS,
  HEAD_SALARY_TIERS,
  BDM_PCT_TIERS,
  type PnlChainState,
} from './commission-calculator';
import { round2 } from './utils';
import type { Period } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Tests del núcleo de cálculo de comisiones. Estos protegen la PLATA — un
// error acá paga de más/de menos a la fuerza comercial. Cubren la fórmula
// estándar (ND/2 + acumulado × pct), los tiers de salario/porcentaje (que
// NO deben tener gaps ni solapamientos), el diferencial de HEAD, y el modo
// PnL Especial (que debe estar aislado del normal, sin acumulado).
// ─────────────────────────────────────────────────────────────────────────────

describe('calculateCommission (fórmula estándar PnL normal)', () => {
  it('ND=0 no paga pero CONSERVA el acumulado arrastrado', () => {
    // Fix auditoría 2026-08-06: antes accumulatedOut salía en 0 y un BDM que
    // venía con $5.000 acumulados los perdía para siempre por un mes sin
    // depósitos (o simplemente sin cargar — el default del input es 0).
    // No se paga nada (pagar sobre el acumulado convertiría cada fila sin
    // cargar en un pago fantasma), pero el acumulado sigue vivo y entra al
    // próximo mes con ND real.
    const r = calculateCommission(0, 5000, 5);
    expect(r.division).toBe(0);
    expect(r.commission).toBe(0);
    expect(r.realPayment).toBe(0);
    expect(r.accumulatedOut).toBe(5000);
  });

  it('tras un ND=0, el mes siguiente paga sobre el acumulado conservado', () => {
    const mesSinDepositos = calculateCommission(0, 50_000, 5);
    const mesSiguiente = calculateCommission(100_000, mesSinDepositos.accumulatedOut, 5);
    // (50.000 de división + 50.000 conservados) × 5% = 5.000
    expect(mesSiguiente.commission).toBe(5_000);
  });

  it('el tier de % nunca degrada un porcentaje negociado mayor', () => {
    // BDM con 7% pactado y ND $120K: el tier de la tabla dice 5%, pero el
    // acuerdo manda (auditoría 2026-08-06: cobraba 3.000 en vez de 4.200).
    expect(calculateBdmPctFromND(120_000, 7)).toBe(7);
    // Y el tier sí mejora un % menor: 3% pactado con ND $200K → 6%.
    expect(calculateBdmPctFromND(200_000, 3)).toBe(6);
    // Sin tier alcanzado, manda el perfil.
    expect(calculateBdmPctFromND(10_000, 4)).toBe(4);
  });

  it('nd_pct_fixed: el % del perfil es fijo y los tramos no aplican ni para subir', () => {
    // El caso que motivó la excepción (2026-09-03): 4% pactado, ND $283K.
    // Sin el flag el tramo lo subía al 6%; con el flag cobra su 4%.
    expect(calculateBdmPctFromND(283_139, 4, true)).toBe(4);
    // Fijo sin % configurado = 0 (no hay acuerdo que respetar).
    expect(calculateBdmPctFromND(283_139, undefined, true)).toBe(0);
    // false y undefined se comportan EXACTAMENTE como antes (regresión).
    expect(calculateBdmPctFromND(283_139, 4, false)).toBe(6);
    expect(calculateBdmPctFromND(283_139, 4)).toBe(6);
    expect(calculateBdmPctFromND(120_000, 7, false)).toBe(7);
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

// ─────────────────────────────────────────────────────────────────────────────
// La cadena del grupo PnL. Lo que protege: el recálculo «desde abril» reescribe
// varios meses seguidos y cada uno depende del ANTERIOR RECALCULADO. Si el
// encadenado se rompe (deuda que no se arrastra, acumulado que se destruye,
// orden invertido) el resultado sigue siendo un número plausible y equivocado
// — el modo de falla que persigue este repo.
// ─────────────────────────────────────────────────────────────────────────────
describe('calcularPasoPnlEncadenado (recálculo mes a mes del grupo PnL)', () => {
  const cero: PnlChainState = { prevDebt: 0, accumulatedIn: 0 };

  it('modo normal: misma fórmula que el ND (pnl/2 + acumulado) × pct, menos lotes', () => {
    const p = calcularPasoPnlEncadenado({
      mode: 'normal', pnlPct: 10, pnl: 100_000, lotCommissions: 1_000, salary: 0, state: cero,
    });
    expect(p.division).toBe(50_000);        // 100.000 / 2
    expect(p.commissionsEarned).toBe(5_000); // 50.000 × 10%
    expect(p.realPayment).toBe(4_000);       // 5.000 − 1.000 de lotes
    expect(p.accumulatedOut).toBe(50_000);   // la división pasa al mes siguiente
    expect(p.next.accumulatedIn).toBe(50_000);
  });

  it('modo normal: el acumulado del mes anterior entra al siguiente y suma comisión', () => {
    const abril = calcularPasoPnlEncadenado({
      mode: 'normal', pnlPct: 10, pnl: 100_000, lotCommissions: 0, salary: 0, state: cero,
    });
    const mayo = calcularPasoPnlEncadenado({
      mode: 'normal', pnlPct: 10, pnl: 100_000, lotCommissions: 0, salary: 0, state: abril.next,
    });
    // (50.000 de división + 50.000 arrastrados) × 10% = 10.000, no 5.000.
    expect(mayo.commissionsEarned).toBe(10_000);
  });

  it('modo normal: un mes SIN dato (PnL 0) no destruye el acumulado', () => {
    // §2.1 regla 2. El caso real es un perfil sin usuario CRM en un mes suelto.
    const abril = calcularPasoPnlEncadenado({
      mode: 'normal', pnlPct: 10, pnl: 100_000, lotCommissions: 0, salary: 0, state: cero,
    });
    const mayoVacio = calcularPasoPnlEncadenado({
      mode: 'normal', pnlPct: 10, pnl: 0, lotCommissions: 0, salary: 0, state: abril.next,
    });
    expect(mayoVacio.realPayment).toBe(0);
    expect(mayoVacio.next.accumulatedIn).toBe(50_000); // intacto
  });

  it('la deuda de un mes se arrastra al siguiente y se salda contra lo ganado', () => {
    // Abril negativo (PNL Report positivo = los clientes ganaron) → deuda.
    const abril = calcularPasoPnlEncadenado({
      mode: 'special', pnlPct: 35, pnl: -10_000, lotCommissions: 0, salary: 0, state: cero,
    });
    expect(abril.totalEarned).toBe(-3_500);
    expect(abril.bonus).toBe(-3_500);          // queda debiendo
    expect(abril.next.prevDebt).toBe(-3_500);

    // Mayo positivo: cobra descontando la deuda de abril.
    const mayo = calcularPasoPnlEncadenado({
      mode: 'special', pnlPct: 35, pnl: 20_000, lotCommissions: 0, salary: 0, state: abril.next,
    });
    expect(mayo.commissionsEarned).toBe(7_000);
    expect(mayo.totalEarned).toBe(3_500);      // 7.000 − 3.500 de deuda
    expect(mayo.bonus).toBe(0);                // saldada
  });

  it('la deuda que NO se salda sigue acumulando hacia el mes siguiente', () => {
    const abril = calcularPasoPnlEncadenado({
      mode: 'special', pnlPct: 35, pnl: -10_000, lotCommissions: 0, salary: 0, state: cero,
    });
    const mayo = calcularPasoPnlEncadenado({
      mode: 'special', pnlPct: 35, pnl: -4_000, lotCommissions: 0, salary: 0, state: abril.next,
    });
    // −1.400 del mes + −3.500 arrastrados
    expect(mayo.bonus).toBe(-4_900);
    expect(mayo.next.prevDebt).toBe(-4_900);
  });

  it('modo especial: nunca arrastra acumulado, sólo deuda', () => {
    const p = calcularPasoPnlEncadenado({
      mode: 'special', pnlPct: 35, pnl: 10_000, lotCommissions: 1_000, salary: 800, state: cero,
    });
    expect(p.division).toBe(0);
    expect(p.netDepositAccumulated).toBe(0);
    expect(p.accumulatedOut).toBe(0);
    expect(p.next.accumulatedIn).toBe(0);
    expect(p.realPayment).toBe(2_500);   // 3.500 − 1.000 de lotes
    expect(p.totalEarned).toBe(3_300);   // 2.500 + 800 de salario
  });

  it('el salario del mes entra al total pero NO a la comisión', () => {
    const p = calcularPasoPnlEncadenado({
      mode: 'normal', pnlPct: 10, pnl: 100_000, lotCommissions: 0, salary: 1_000, state: cero,
    });
    expect(p.commissionsEarned).toBe(5_000);
    expect(p.salaryPaid).toBe(1_000);
    expect(p.totalEarned).toBe(6_000);
  });

  it('EL ORDEN IMPORTA: recorrer los meses al revés da otro número', () => {
    // El control que justifica que el recálculo sea secuencial y cronológico.
    const mesA = { mode: 'special' as const, pnlPct: 35, pnl: -10_000, lotCommissions: 0, salary: 0 };
    const mesB = { mode: 'special' as const, pnlPct: 35, pnl: 20_000, lotCommissions: 0, salary: 0 };

    const enOrden = calcularPasoPnlEncadenado({
      ...mesB, state: calcularPasoPnlEncadenado({ ...mesA, state: cero }).next,
    });
    const alReves = calcularPasoPnlEncadenado({
      ...mesA, state: calcularPasoPnlEncadenado({ ...mesB, state: cero }).next,
    });
    expect(enOrden.totalEarned).toBe(3_500);
    expect(alReves.totalEarned).toBe(-3_500);
    expect(enOrden.totalEarned).not.toBe(alReves.totalEarned);
  });

  it('el guardado a mano y el recálculo dan EXACTAMENTE el mismo número (§2.1 A3)', () => {
    // Un mismo número tiene que salir del mismo camino. Acá se compara el paso
    // encadenado contra la composición que hace handleSaveBdm en la pantalla.
    const pnl = 87_432.19, lotes = 3_399.39, salario = 800, pct = 12, accIn = 12_345.67, deuda = -900;

    const paso = calcularPasoPnlEncadenado({
      mode: 'normal', pnlPct: pct, pnl, lotCommissions: lotes, salary: salario,
      state: { prevDebt: deuda, accumulatedIn: accIn },
    });

    const aMano = calculateCommission(pnl, accIn, pct);
    const realAMano = round2(aMano.realPayment - lotes);
    const { finalTotalEarned, debtOut } = applyTotalEarnedDebt(deuda, realAMano + salario);
    expect(paso.commissionsEarned).toBe(aMano.commission);
    expect(paso.realPayment).toBe(realAMano);
    expect(paso.accumulatedOut).toBe(aMano.accumulatedOut);
    expect(paso.totalEarned).toBe(finalTotalEarned);
    expect(paso.bonus).toBe(debtOut);
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
