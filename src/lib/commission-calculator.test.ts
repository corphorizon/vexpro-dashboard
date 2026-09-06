import { describe, it, expect } from 'vitest';
import {
  calculateCommission,
  calculateSalaryFromND,
  calculateHeadSalaryFromND,
  calculateBdmPctFromND,
  resolvePctDelMes,
  pctPropioDelLiderDeGrupo,
  pctPropioDeLineaDeGrupo,
  diffNaturalDeLinea,
  resolveDiffPctDeLinea,
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

  it('pct_override: el % manual del mes pisa tramos, % fijo y % del perfil', () => {
    // El mismo caso de arriba, con un 3 tecleado para ESE mes.
    expect(resolvePctDelMes(3, calculateBdmPctFromND(283_139, 4))).toBe(3);
    expect(resolvePctDelMes(3, calculateBdmPctFromND(283_139, 4, true))).toBe(3);
    // Y no hace falta que sea menor: sube igual.
    expect(resolvePctDelMes(9, calculateBdmPctFromND(10_000, 4))).toBe(9);
  });

  it('pct_override: VACÍO (null/undefined) no es CERO', () => {
    // El 0 tecleado es una decisión: ese mes no se paga comisión.
    expect(resolvePctDelMes(0, 6)).toBe(0);
    expect(calculateCommission(283_139, 0, resolvePctDelMes(0, 6)).commission).toBe(0);
    // null/undefined = no hay override: manda el automático, intacto.
    expect(resolvePctDelMes(null, 6)).toBe(6);
    expect(resolvePctDelMes(undefined, 6)).toBe(6);
    // Y el automático de 0 sigue siendo 0 sin override (regresión de §1.3).
    expect(resolvePctDelMes(null, 0)).toBe(0);
  });

  it('pct_override: un override negativo NO se clampea (es deuda, como el ND)', () => {
    expect(resolvePctDelMes(-2, 6)).toBe(-2);
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

  it('pct_linea pisa el diferencial de ESA línea y no toca las demás', () => {
    const r = calculateHeadDifferential(7, 0, [
      { profileId: 'b1', name: 'BDM1', netDepositCurrent: 100_000, accumulatedIn: 0, commissionPct: 4, pctLinea: 1 },
      { profileId: 'b2', name: 'BDM2', netDepositCurrent: 100_000, accumulatedIn: 0, commissionPct: 4 },
    ]);
    expect(r.details[0].diffPct).toBe(1);   // pisado
    expect(r.details[0].commission).toBe(500); // 50k × 1%
    expect(r.details[1].diffPct).toBe(3);   // intacto
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EL % POR LÍNEA (migración 130) — lo que cobra EL DE ARRIBA por la línea del
// de abajo. La mitad de estos tests son de REGRESIÓN: sin `pct_linea` cargado
// el número tiene que ser bit a bit el de antes, porque el diferencial natural
// se mudó desde `bdmCalcs` (/comisiones) a `diffNaturalDeLinea` y una mudanza
// que cambia un decimal no lanza ninguna excepción (§1.2).
// ─────────────────────────────────────────────────────────────────────────────

describe('diffNaturalDeLinea (el diferencial de siempre, ahora con nombre)', () => {
  /** La expresión EXACTA que vivía inline en bdmCalcs antes de la 130. */
  const comoEstabaAntes = (refPct: number, pctPropio: number, extraPct: number) => {
    const naturalDiff = refPct - pctPropio;
    return naturalDiff > 0 ? naturalDiff : naturalDiff === 0 ? extraPct : 0;
  };

  it('reproduce bit a bit la expresión que vivía en bdmCalcs', () => {
    const casos: [number, number, number][] = [
      [7, 4, 0], [7, 4, 1], [4, 4, 1], [4, 4, 0], [5, 6, 2], [5, 6, 0],
      [0, 0, 0], [0, 0, 3], [6, 0, 0], [2.5, 1.25, 0.5], [-1, 0, 1],
    ];
    for (const [ref, propio, extra] of casos) {
      expect(diffNaturalDeLinea(ref, propio, extra)).toBe(comoEstabaAntes(ref, propio, extra));
    }
  });

  it('§2.1 regla 7 — el diferencial del head NUNCA es negativo', () => {
    // Head 5% con un BDM tierizado a 6%: el head cobra 0, no −1 (le restaba
    // $1.000 al head, auditoría 2026-08-06). Y el extra NO lo rescata.
    expect(diffNaturalDeLinea(5, 6, 0)).toBe(0);
    expect(diffNaturalDeLinea(5, 6, 2)).toBe(0);
  });

  it('§2.1 regla 8 — extra_pct sólo con diferencial natural EXACTAMENTE 0', () => {
    expect(diffNaturalDeLinea(4, 4, 1)).toBe(1);   // mismo % → entra el extra
    expect(diffNaturalDeLinea(7, 4, 1)).toBe(3);   // natural > 0 → NO se suma
  });

  it('el % del master normalmente es 0 → el BDM cobra su % COMPLETO por esa línea', () => {
    // La analogía de la 130: el Master IB dentro de un BDM es el BDM dentro de
    // un head. Un master no tiene net_deposit_pct, así que el natural da el %
    // entero del BDM — que es lo que económicamente ya pasaba (el BDM cobra su
    // % sobre el total de su línea, master incluido).
    expect(diffNaturalDeLinea(4, 0, 0)).toBe(4);
  });
});

describe('resolveDiffPctDeLinea (la pisada por línea)', () => {
  it('sin pisada (null/undefined) manda el diferencial natural, intacto', () => {
    expect(resolveDiffPctDeLinea(null, 3)).toBe(3);
    expect(resolveDiffPctDeLinea(undefined, 3)).toBe(3);
    // Y un natural de 0 sigue siendo 0 sin pisada (regresión §1.3).
    expect(resolveDiffPctDeLinea(null, 0)).toBe(0);
    expect(resolveDiffPctDeLinea(undefined, 0)).toBe(0);
  });

  it('el caso del dueño: Luka cobra 1% por la línea de Ana', () => {
    // Ana al 4% bajo un head al 4%: el natural daba 0 (o el extra_pct). Con
    // pct_linea = 1 el head cobra 1% sin que a Ana le cambie nada.
    expect(resolveDiffPctDeLinea(1, diffNaturalDeLinea(4, 4, 0))).toBe(1);
    // Sobre la MISMA base de siempre: ND 100k → división 50k → 1% = 500.
    expect(calculateCommission(100_000, 0, resolveDiffPctDeLinea(1, diffNaturalDeLinea(4, 4, 0))).commission).toBe(500);
  });

  it('VACÍO no es CERO: 0 = el de arriba no cobra nada por esta línea', () => {
    expect(resolveDiffPctDeLinea(0, 3)).toBe(0);
    expect(calculateCommission(100_000, 0, resolveDiffPctDeLinea(0, 3)).commission).toBe(0);
    // Un `pisada || natural` habría devuelto 3 acá y pagado igual, sin error.
    expect(resolveDiffPctDeLinea(0, 3)).not.toBe(3);
  });

  it('el clamp «nunca negativo» NO se le aplica a la pisada', () => {
    // El natural clampeaba a 0 (BDM tierizado por encima del head); la pisada
    // manda igual: el dueño puso 1% y se cobra 1%.
    expect(resolveDiffPctDeLinea(1, diffNaturalDeLinea(5, 6, 0))).toBe(1);
    // Y una pisada negativa tampoco se clampea: es un acuerdo, no un derivado
    // (mismo criterio que pct_override).
    expect(resolveDiffPctDeLinea(-2, 3)).toBe(-2);
  });

  it('una pisada MAYOR que el % del head se permite (el dueño manda)', () => {
    expect(resolveDiffPctDeLinea(9, diffNaturalDeLinea(4, 4, 0))).toBe(9);
  });

  it('la pisada NO toca el % propio del de abajo', () => {
    // El % del mes de la persona sale de su propio camino (tramos + override)
    // y `pct_linea` no participa: son dos números distintos.
    expect(resolvePctDelMes(null, calculateBdmPctFromND(120_000, 7))).toBe(7);
    expect(resolveDiffPctDeLinea(1, diffNaturalDeLinea(7, 7, 0))).toBe(1);
  });
});

describe('pctPropioDelLiderDeGrupo (el % propio del que lidera un grupo)', () => {
  it('un HEAD cobra su % pactado: los tramos NO lo tocan', () => {
    // La rama de siempre, byte por byte: un ND de $283K no lo sube al 6%.
    expect(
      pctPropioDelLiderDeGrupo({ liderEsBdm: false, profilePct: 4, nd: 283_139 }),
    ).toBe(4);
    // Y el pct_override tampoco entra por esta rama (el head no tiene celda).
    expect(
      pctPropioDelLiderDeGrupo({ liderEsBdm: false, profilePct: 4, nd: 0, pctOverride: 9 }),
    ).toBe(4);
  });

  it('un BDM que lidera su grupo NO pierde sus tramos', () => {
    // El mismo número que le da su línea en el grupo de su head: si acá se
    // leyera `net_deposit_pct` a secas, la misma persona cobraría 4% en una
    // pantalla y 6% en la otra, sin lanzar ninguna excepción.
    expect(pctPropioDelLiderDeGrupo({ liderEsBdm: true, profilePct: 4, nd: 283_139 }))
      .toBe(calculateBdmPctFromND(283_139, 4));
    expect(pctPropioDelLiderDeGrupo({ liderEsBdm: true, profilePct: 4, nd: 283_139 })).toBe(6);
    // Bajo el piso del primer tramo manda el % del perfil.
    expect(pctPropioDelLiderDeGrupo({ liderEsBdm: true, profilePct: 4, nd: 10_000 })).toBe(4);
  });

  it('`nd_pct_fixed` apaga los tramos también para el líder (migración 128)', () => {
    expect(
      pctPropioDelLiderDeGrupo({ liderEsBdm: true, profilePct: 4, nd: 283_139, ndPctFixed: true }),
    ).toBe(4);
  });

  it('con salario fijo no se tieriza — mismo criterio que su línea bajo el head', () => {
    expect(
      pctPropioDelLiderDeGrupo({ liderEsBdm: true, profilePct: 4, nd: 283_139, fixedSalary: true }),
    ).toBe(4);
  });

  it('el % manual del mes pisa el automático, y 0 no es vacío (§1.3)', () => {
    expect(
      pctPropioDelLiderDeGrupo({ liderEsBdm: true, profilePct: 4, nd: 283_139, pctOverride: 3 }),
    ).toBe(3);
    expect(
      pctPropioDelLiderDeGrupo({ liderEsBdm: true, profilePct: 4, nd: 283_139, pctOverride: 0 }),
    ).toBe(0);
    expect(
      pctPropioDelLiderDeGrupo({ liderEsBdm: true, profilePct: 4, nd: 283_139, pctOverride: null }),
    ).toBe(6);
  });

  it('es el % de REFERENCIA del diferencial de cada línea del grupo', () => {
    // Master sin % propio bajo un BDM al 6%: el natural es el % completo del
    // BDM (lo que ya pasaba económicamente), y `pct_linea` lo pisa si está.
    const bdmPct = pctPropioDelLiderDeGrupo({ liderEsBdm: true, profilePct: 4, nd: 283_139 });
    expect(diffNaturalDeLinea(bdmPct, 0, 0)).toBe(6);
    expect(resolveDiffPctDeLinea(1, diffNaturalDeLinea(bdmPct, 0, 0))).toBe(1);
  });
});

describe('pctPropioDeLineaDeGrupo (el % del de abajo, con el que se saca el diferencial)', () => {
  it('en un grupo de HEAD es la precedencia de siempre, intacta', () => {
    const base = { grupoLideradoPorBdm: false, esSubHead: false, profilePct: 4 };
    // BDM normal: los tramos son piso, nunca techo.
    expect(pctPropioDeLineaDeGrupo({ ...base, nd: 283_139 })).toBe(6);
    expect(pctPropioDeLineaDeGrupo({ ...base, nd: 10_000 })).toBe(4);
    expect(pctPropioDeLineaDeGrupo({ ...base, nd: 120_000, profilePct: 7 })).toBe(7);
    // Sub-head y salario fijo: su % pactado, sin tramos.
    expect(pctPropioDeLineaDeGrupo({ ...base, esSubHead: true, nd: 283_139 })).toBe(4);
    expect(pctPropioDeLineaDeGrupo({ ...base, fixedSalary: true, nd: 283_139 })).toBe(4);
    // Y `nd_pct_fixed` (migración 128).
    expect(pctPropioDeLineaDeGrupo({ ...base, ndPctFixed: true, nd: 283_139 })).toBe(4);
  });

  it('la línea de un MASTER IB no se tieriza — si no, la BDM cobra 0 por ella', () => {
    // Un master sin % configurado y un mes de $283K: con tramos daba 6%, el
    // diferencial natural de una BDM al 6% caía a 0 y ella no cobraba nada por
    // la línea que el dueño dijo que cobra. No lanza ninguna excepción: paga mal.
    const master = { grupoLideradoPorBdm: true, esSubHead: false, profilePct: 0, nd: 283_139 };
    expect(pctPropioDeLineaDeGrupo(master)).toBe(0);
    expect(diffNaturalDeLinea(6, pctPropioDeLineaDeGrupo(master), 0)).toBe(6);
    // El contraste, en la misma línea con el grupo de un head: 6% tierizado.
    expect(pctPropioDeLineaDeGrupo({ ...master, grupoLideradoPorBdm: false })).toBe(6);
    expect(diffNaturalDeLinea(6, pctPropioDeLineaDeGrupo({ ...master, grupoLideradoPorBdm: false }), 0)).toBe(0);
  });

  it('un master CON % configurado conserva ese %, y `pct_linea` lo pisa igual', () => {
    const conPct = pctPropioDeLineaDeGrupo({ grupoLideradoPorBdm: true, esSubHead: false, profilePct: 2, nd: 283_139 });
    expect(conPct).toBe(2);
    expect(diffNaturalDeLinea(6, conPct, 0)).toBe(4);
    expect(resolveDiffPctDeLinea(1, diffNaturalDeLinea(6, conPct, 0))).toBe(1);
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
