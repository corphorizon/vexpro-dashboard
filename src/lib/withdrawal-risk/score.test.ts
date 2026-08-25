// ─────────────────────────────────────────────────────────────────────────────
// Tests del motor de riesgo de retiros.
//
// Lo que estos tests FIJAN (y por lo tanto lo que romperá si alguien toca el
// modelo sin querer):
//   · cada señal medida mueve el score EN LA DIRECCIÓN observada,
//   · las tres señales descartadas (KYC, deuda, dirección compartida) NO lo
//     mueven ni un punto — ese es el test que hay que mirar cuando alguien
//     proponga "agregarlas",
//   · las features son punto-en-el-tiempo: un movimiento POSTERIOR a la
//     solicitud no cuenta,
//   · el score es determinista y no depende del reloj.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { computeFeatures, type FeatureInput } from './features';
import {
  scoreWithdrawal,
  bandsFor,
  informativeNotes,
  calibrationFromParam,
  RECENT_6M,
  FULL_HISTORY,
  DEFAULT_CALIBRATION,
} from './score';

const REQ = '2026-08-01T12:00:00.000Z';
const REG_OLD = '2025-01-01T00:00:00.000Z';

/** Perfil limpio: cliente viejo, depositó mucho, pide poco, sin rechazos. */
function cleanInput(over: Partial<FeatureInput> = {}): FeatureInput {
  return {
    amount: 200,
    requestedAt: REQ,
    depositsBefore: [{ amount: 5000, at: '2026-01-10T00:00:00.000Z' }],
    withdrawalsApprovedBefore: [{ amount: 1000, at: '2026-03-01T00:00:00.000Z' }],
    rejectedCountBefore: 0,
    registerDate: REG_OLD,
    kycStatus: 'VERIFIED',
    pendingFeeDebt: 0,
    sharedAddressUserCount: 1,
    ...over,
  };
}

const scoreOf = (over: Partial<FeatureInput> = {}) =>
  scoreWithdrawal(computeFeatures(cleanInput(over))).approvalScore;

describe('computeFeatures — punto en el tiempo', () => {
  it('ignora un depósito POSTERIOR a la solicitud', () => {
    const antes = computeFeatures(cleanInput());
    const despues = computeFeatures(
      cleanInput({
        depositsBefore: [
          { amount: 5000, at: '2026-01-10T00:00:00.000Z' },
          // Este entra DESPUÉS de pedir: no puede contar.
          { amount: 999_999, at: '2026-08-02T00:00:00.000Z' },
        ],
      }),
    );
    expect(despues.depositedBefore).toBe(antes.depositedBefore);
    expect(despues.depositCountBefore).toBe(1);
  });

  it('ignora un retiro aprobado POSTERIOR a la solicitud', () => {
    const f = computeFeatures(
      cleanInput({
        withdrawalsApprovedBefore: [
          { amount: 1000, at: '2026-03-01T00:00:00.000Z' },
          { amount: 4000, at: '2026-08-15T00:00:00.000Z' },
        ],
      }),
    );
    expect(f.withdrawnBefore).toBe(1000);
    expect(f.netBefore).toBe(4000);
  });

  it('un movimiento EXACTAMENTE en requested_at no cuenta (corte estricto)', () => {
    const f = computeFeatures(cleanInput({ depositsBefore: [{ amount: 5000, at: REQ }] }));
    expect(f.depositedBefore).toBe(0);
    expect(f.hasDeposits).toBe(false);
  });

  it('sin requested_at devuelve historial vacío en vez de contar el futuro', () => {
    const f = computeFeatures(cleanInput({ requestedAt: null }));
    expect(f.depositedBefore).toBe(0);
    expect(f.ratioBucket).toBe('no_deposits');
  });

  it('clasifica los tramos medidos', () => {
    expect(computeFeatures(cleanInput()).ratioBucket).toBe('lt_0_5'); // 200/5000
    expect(computeFeatures(cleanInput({ amount: 3500 })).ratioBucket).toBe('b_0_5_1');
    expect(computeFeatures(cleanInput({ amount: 7000 })).ratioBucket).toBe('b_1_2');
    expect(computeFeatures(cleanInput({ amount: 20_000 })).ratioBucket).toBe('gt_2');
    expect(computeFeatures(cleanInput({ depositsBefore: [] })).ratioBucket).toBe('no_deposits');

    expect(computeFeatures(cleanInput()).netBucket).toBe('gt_500'); // 5000-1000
    expect(computeFeatures(cleanInput({ registerDate: '2026-08-01T06:00:00.000Z' })).ageBucket).toBe('lt_1d');
    expect(computeFeatures(cleanInput({ registerDate: '2026-07-29T00:00:00.000Z' })).ageBucket).toBe('b_1_7d');
    expect(computeFeatures(cleanInput({ registerDate: '2026-07-20T00:00:00.000Z' })).ageBucket).toBe('b_7_30d');
    expect(computeFeatures(cleanInput({ registerDate: null })).ageBucket).toBe('unknown');

    expect(computeFeatures(cleanInput({ rejectedCountBefore: 0 })).rejectionBucket).toBe('r0');
    expect(computeFeatures(cleanInput({ rejectedCountBefore: 1 })).rejectionBucket).toBe('r1');
    expect(computeFeatures(cleanInput({ rejectedCountBefore: 2 })).rejectionBucket).toBe('r2');
    expect(computeFeatures(cleanInput({ rejectedCountBefore: 7 })).rejectionBucket).toBe('r3plus');
  });
});

describe('scoreWithdrawal — dirección de cada señal medida', () => {
  it('un perfil limpio supera 90', () => {
    const r = scoreWithdrawal(computeFeatures(cleanInput()));
    expect(r.approvalScore).toBeGreaterThan(90);
    expect(r.band).toBe('low');
  });

  it('rechazos previos: 0 > 1 > 2 > 3+ (2,14% → 23,30% → 36,97% → 47,78%)', () => {
    const s = [0, 1, 2, 3].map((n) => scoreOf({ rejectedCountBefore: n }));
    expect(s[0]).toBeGreaterThan(s[1]);
    expect(s[1]).toBeGreaterThan(s[2]);
    expect(s[2]).toBeGreaterThan(s[3]);
  });

  it('ratio: <0,5x es el mejor tramo y 0,5-1x el peor (2,60% vs 12,39%)', () => {
    // Orden MEDIDO tres veces contra prod con los buckets exactos de
    // ratioBucketOf, en tres ventanas: 0,5-1x rechaza más que 1-2x siempre
    // (6m 12,39 vs 6,14 · completo 14,21 vs 8,37 · antes de 6m 18,12 vs 13,49).
    // Es contraintuitivo —pedir MÁS se rechaza menos que pedir casi todo— y
    // por eso el test lo fija: una versión previa tenía los pesos invertidos.
    const bajo = scoreOf({ amount: 200 }); // 0,04x
    const casiTodo = scoreOf({ amount: 3500 }); // 0,7x — el tramo MÁS rechazado
    const masQueTodo = scoreOf({ amount: 7000 }); // 1,4x
    const muyAlto = scoreOf({ amount: 20_000 }); // 4x
    expect(bajo).toBeGreaterThan(casiTodo);
    expect(bajo).toBeGreaterThan(masQueTodo);
    // El peor de los cuatro es 0,5-1x, no los grandes.
    expect(casiTodo).toBeLessThan(masQueTodo);
    expect(casiTodo).toBeLessThan(muyAlto);
    // Y >2x sí es peor que 1-2x (10,03% vs 6,14%).
    expect(muyAlto).toBeLessThan(masQueTodo);
  });

  it('antigüedad: <1d es el peor tramo (21,67% de rechazo)', () => {
    const nueva = scoreOf({ registerDate: '2026-08-01T06:00:00.000Z' });
    const semana = scoreOf({ registerDate: '2026-07-29T00:00:00.000Z' });
    const mes = scoreOf({ registerDate: '2026-07-20T00:00:00.000Z' });
    expect(nueva).toBeLessThan(semana);
    expect(semana).toBeLessThan(mes);
  });

  it('neto: muy negativo es el MEJOR tramo (1,69%), 0..500 el peor (7,00%)', () => {
    // Neto < -1000 = el cliente ya retiró mucho más de lo que puso. Contra la
    // intuición, es el perfil que MENOS se rechaza (cliente ganador y viejo).
    const muyNegativo = scoreOf({
      depositsBefore: [{ amount: 1000, at: '2026-01-10T00:00:00.000Z' }],
      withdrawalsApprovedBefore: [{ amount: 5000, at: '2026-03-01T00:00:00.000Z' }],
      amount: 100,
    });
    const chico = scoreOf({
      depositsBefore: [{ amount: 1000, at: '2026-01-10T00:00:00.000Z' }],
      withdrawalsApprovedBefore: [{ amount: 800, at: '2026-03-01T00:00:00.000Z' }],
      amount: 100,
    });
    expect(muyNegativo).toBeGreaterThan(chico);
  });

  it('sin fecha de alta la antigüedad aporta exactamente 0 (dato faltante ≠ sospecha)', () => {
    const f = computeFeatures(cleanInput({ registerDate: null }));
    const factor = scoreWithdrawal(f).factors.find((x) => x.code === 'account_age')!;
    expect(factor.weight).toBe(0);
    expect(factor.impact).toBe('neutral');
  });

  it('3 rechazos previos + ratio >2x cae en banda alta', () => {
    const r = scoreWithdrawal(
      computeFeatures(cleanInput({ rejectedCountBefore: 3, amount: 20_000 })),
    );
    expect(r.band).toBe('high');
    expect(r.approvalScore).toBeLessThan(bandsFor().high);
  });

  it('el peor perfil posible queda muy por debajo del mejor', () => {
    const peor = scoreOf({
      rejectedCountBefore: 5,
      amount: 7000,
      registerDate: '2026-08-01T06:00:00.000Z',
      depositsBefore: [{ amount: 5000, at: '2026-07-31T00:00:00.000Z' }],
      withdrawalsApprovedBefore: [{ amount: 4800, at: '2026-07-31T06:00:00.000Z' }],
    });
    expect(peor).toBeLessThan(50);
    expect(scoreOf()).toBeGreaterThan(peor + 40);
  });
});

describe('señales DESCARTADAS — no deben mover el score', () => {
  const baseScore = scoreWithdrawal(computeFeatures(cleanInput()));

  it('el KYC no mueve el score (los 915 rechazos son todos VERIFIED)', () => {
    for (const kyc of ['NONE', 'PENDING', 'REJECTED', 'VERIFIED', null]) {
      const r = scoreWithdrawal(computeFeatures(cleanInput({ kycStatus: kyc })));
      expect(r.approvalScore).toBe(baseScore.approvalScore);
      expect(r.logOdds).toBe(baseScore.logOdds);
    }
  });

  it('la deuda de comisiones no mueve el score (34 casos, 0 rechazos)', () => {
    for (const debt of [0, 1, 500, 100_000]) {
      expect(scoreWithdrawal(computeFeatures(cleanInput({ pendingFeeDebt: debt }))).approvalScore).toBe(
        baseScore.approvalScore,
      );
    }
  });

  it('la dirección compartida no mueve el score (6,18% vs 7,39%: se rechazan MENOS)', () => {
    for (const n of [0, 1, 2, 50]) {
      expect(
        scoreWithdrawal(computeFeatures(cleanInput({ sharedAddressUserCount: n }))).approvalScore,
      ).toBe(baseScore.approvalScore);
    }
  });

  it('ningún factor del score corresponde a una señal descartada', () => {
    const codes = baseScore.factors.map((f) => f.code);
    expect(codes).toEqual([
      'prior_rejections',
      'amount_ratio',
      'account_age',
      'net_before',
      // Agregada el 2026-08-25 tras medirla: es la única señal de "origen del
      // dinero" que predice. Ver los tests de más abajo.
      'money_origin',
    ]);
    for (const prohibido of ['kyc', 'fee_debt', 'shared_address']) {
      expect(codes).not.toContain(prohibido);
    }
  });

  it('las descartadas se exponen aparte y siempre con affectsScore:false', () => {
    const notes = informativeNotes(computeFeatures(cleanInput({ sharedAddressUserCount: 3 })));
    expect(notes.map((n) => n.code)).toEqual(['kyc', 'fee_debt', 'shared_address']);
    expect(notes.every((n) => n.affectsScore === false)).toBe(true);
    expect(notes.find((n) => n.code === 'shared_address')!.value).toContain('2 usuarios');
  });
});

describe('mecánica del modelo', () => {
  it('es determinista: 50 corridas dan exactamente lo mismo', () => {
    const f = computeFeatures(cleanInput({ rejectedCountBefore: 1, amount: 3500 }));
    const first = JSON.stringify(scoreWithdrawal(f));
    for (let i = 0; i < 50; i++) expect(JSON.stringify(scoreWithdrawal(f))).toBe(first);
  });

  it('el logOdds es exactamente la base más la suma de los pesos mostrados', () => {
    const r = scoreWithdrawal(computeFeatures(cleanInput({ rejectedCountBefore: 2 })));
    const base = Math.log((1 - RECENT_6M.baseRejectionRate) / RECENT_6M.baseRejectionRate);
    const suma = r.factors.reduce((a, f) => a + f.weight, base);
    expect(suma).toBeCloseTo(r.logOdds, 10);
    expect(r.approvalScore).toBeCloseTo(Math.round((100 / (1 + Math.exp(-r.logOdds))) * 10) / 10, 10);
  });

  it('el signo de impact coincide con el signo del peso', () => {
    const r = scoreWithdrawal(computeFeatures(cleanInput({ rejectedCountBefore: 3, amount: 7000 })));
    for (const f of r.factors) {
      if (f.impact === 'up') expect(f.weight).toBeGreaterThan(0);
      if (f.impact === 'down') expect(f.weight).toBeLessThan(0);
      if (f.impact === 'neutral') expect(Math.abs(f.weight)).toBeLessThanOrEqual(0.05);
    }
  });

  it('los factores traen el número medido en el detalle, en español', () => {
    const r = scoreWithdrawal(computeFeatures(cleanInput({ rejectedCountBefore: 2 })));
    const f = r.factors.find((x) => x.code === 'prior_rejections')!;
    expect(f.label).toBe('Rechazos previos');
    expect(f.detail).toContain('2 rechazos anteriores');
    expect(f.detail).toContain('37,0%'); // 0,3697 medido para el tramo r2
    expect(f.impact).toBe('down');
  });
});

describe('deriva temporal y bandas', () => {
  it('el default es la ventana reciente, no el histórico completo', () => {
    expect(DEFAULT_CALIBRATION.id).toBe(RECENT_6M.id);
    expect(calibrationFromParam(null).id).toBe(RECENT_6M.id);
    expect(calibrationFromParam('full_history').id).toBe(FULL_HISTORY.id);
    // Un valor basura cae al default en vez de romper la pantalla.
    expect(calibrationFromParam('cualquier-cosa').id).toBe(RECENT_6M.id);
  });

  it('los cortes de banda se derivan de la tasa base de la ventana', () => {
    expect(bandsFor(RECENT_6M).low).toBeCloseTo(94.9, 6);
    expect(bandsFor(RECENT_6M).high).toBeCloseTo(82.15, 6);
    // Histórico: base peor → cortes más bajos, misma semántica.
    expect(bandsFor(FULL_HISTORY).low).toBeCloseTo(92.92, 6);
    expect(bandsFor(FULL_HISTORY).high).toBeCloseTo(75.22, 6);
    expect(bandsFor(FULL_HISTORY).low).toBeLessThan(bandsFor(RECENT_6M).low);
  });

  it('con el criterio actual el mismo perfil puntúa mejor que con el histórico', () => {
    const f = computeFeatures(cleanInput());
    expect(scoreWithdrawal(f, RECENT_6M).approvalScore).toBeGreaterThan(
      scoreWithdrawal(f, FULL_HISTORY).approvalScore,
    );
  });

  it('las bandas ordenan: low > medium > high en score', () => {
    const low = scoreWithdrawal(computeFeatures(cleanInput()));
    const high = scoreWithdrawal(computeFeatures(cleanInput({ rejectedCountBefore: 3, amount: 7000 })));
    expect(low.band).toBe('low');
    expect(high.band).toBe('high');
    expect(low.approvalScore).toBeGreaterThan(high.approvalScore);
  });
});

describe('origen del dinero — la señal más fuerte, y la que contradice la intuición', () => {
  const conP2p = (p2pReceived: number, extra: Record<string, unknown> = {}) =>
    scoreWithdrawal(computeFeatures(cleanInput({ amount: 1000, p2pReceived, ...extra })));

  it('recibir P2P que cubre el retiro baja el score más que recibir menos', () => {
    // Medido: 11,62% de rechazo cuando el P2P cubre el retiro, 8,35% cuando no
    // llega, 3,90% sin P2P. Monótona.
    const sin = conP2p(0).approvalScore;
    const parcial = conP2p(400).approvalScore;
    const cubre = conP2p(5000).approvalScore;
    expect(sin).toBeGreaterThan(parcial);
    expect(parcial).toBeGreaterThan(cubre);
  });

  it('el personal del broker NO se penaliza por recibir dinero', () => {
    // Un BDM cobra comisiones: retirar sin haber depositado es su forma normal
    // de operar. Rechazan al 1,70%, POR DEBAJO de la base.
    const staff = conP2p(5000, { email: 'alguien@vexprofx.com' });
    const cliente = conP2p(5000, { email: 'alguien@gmail.com' });
    expect(staff.approvalScore).toBeGreaterThan(cliente.approvalScore);
    expect(staff.factors.find((f) => f.code === 'money_origin')!.detail).toContain('Personal del broker');
  });

  it('el subdominio del correo también cuenta como personal', () => {
    const a = conP2p(5000, { email: 'x@mail.vexprofx.com' }).approvalScore;
    const b = conP2p(5000, { email: 'x@vexprofx.com' }).approvalScore;
    expect(a).toBe(b);
  });

  it('un correo parecido pero ajeno NO cuenta como personal', () => {
    // `@notvexprofx.com` termina en el dominio si se compara mal.
    const falso = conP2p(5000, { email: 'x@notvexprofx.com' }).approvalScore;
    const cliente = conP2p(5000, { email: 'x@gmail.com' }).approvalScore;
    expect(falso).toBe(cliente);
  });

  it('el detalle explica de dónde vino el dinero, no sólo que hay riesgo', () => {
    const f = conP2p(5000).factors.find((x) => x.code === 'money_origin')!;
    expect(f.detail).toContain('transferencias de otros usuarios');
  });
});
