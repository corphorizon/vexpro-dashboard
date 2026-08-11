import { describe, it, expect } from 'vitest';
import { computeDistributionChain, type PeriodDistInput } from './distribution';
import { applySnapshotOverrides, type PeriodLike } from './distribution-snapshot';
import {
  buildDistributionInputs,
  type DistributionSources,
  type PeriodForInputs,
} from './distribution-inputs';
import { projectCashflow, incomeOf, type RealMonth } from './forecast';

// ─────────────────────────────────────────────────────────────────────────────
// CONTRATO: UNA SOLA VERDAD POR NÚMERO.
//
// Cada número de la cadena (ingresos netos, egresos netos, saldo a favor,
// reserva, monto a distribuir) tiene que salir del MISMO camino sin importar
// quién lo pida: /balances y /finanzas (computeSaldoChain), el forecast
// (projectCashflow) o el aviso de deriva (applySnapshotOverrides).
//
// Este archivo existe porque el modo de falla número uno de este repo es
// duplicar una fórmula "solo para esta pantalla" y que las dos copias se
// separen en silencio (BUG-01: /balances mostraba un Monto a Distribuir
// inflado que contradecía a /socios para el mismo mes; C2: el snapshot de
// cierre era write-only y editar el pasado re-repartía plata ya distribuida).
// Si alguien vuelve a duplicar una fórmula, alguno de estos asserts cae.
// ─────────────────────────────────────────────────────────────────────────────

// Tres períodos: uno normal, uno NEGATIVO (arrastra deuda) y uno con reserva
// distinta del 10% default. Los tres ejes donde las copias divergían.
/** Un período que sirve al builder Y al congelador, sin castings. */
type TestPeriod = PeriodForInputs & PeriodLike;

const periods: TestPeriod[] = [
  { id: 'p1', year: 2026, month: 1, label: 'Ene 26', is_closed: true, reserve_pct: 0.1 },
  { id: 'p2', year: 2026, month: 2, label: 'Feb 26', is_closed: true, reserve_pct: 0.1 },
  { id: 'p3', year: 2026, month: 3, label: 'Mar 26', is_closed: false, reserve_pct: 0.25 },
];

const sources: DistributionSources = {
  operatingIncome: [
    { period_id: 'p1', broker_pnl: 50_000, other: 5_000 },   // normal
    { period_id: 'p2', broker_pnl: 4_000, other: 0 },        // negativo
    { period_id: 'p3', broker_pnl: 80_000, other: 2_000 },   // reserva 25%
  ],
  propFirmSales: [{ period_id: 'p1', amount: 3_000 }],
  withdrawals: [
    { period_id: 'p1', category: 'prop_firm', amount: 1_000 },
    { period_id: 'p1', category: 'broker', amount: 25_000 }, // NO entra a la cadena
    { period_id: 'p3', category: 'ib_commissions', amount: 7_000 }, // tampoco
  ],
  expenses: [
    // `paid` < `amount` en p1: el eje devengado-vs-caja, que solo mira 'company'.
    { period_id: 'p1', amount: 12_000, paid: 9_000 },
    { period_id: 'p2', amount: 30_000, paid: 30_000 }, // 4.000 − 30.000 ⇒ mes negativo
    { period_id: 'p3', amount: 10_000, paid: 10_000 },
  ],
  investments: [{ date: '2026-03-09', profit: 1_500 }],
};

/** El camino "producto": exactamente lo que hace computeSaldoChain(). */
function productChain(periodsIn: TestPeriod[] = periods, src = sources) {
  const live = buildDistributionInputs(periodsIn, src);
  const { inputs } = applySnapshotOverrides(periodsIn, live);
  return computeDistributionChain(inputs);
}

describe('contrato — el dataset ejercita los tres casos', () => {
  it('normal, negativo y reserva variable', () => {
    const chain = productChain();
    expect(chain.get('p1')!.saldoAFavor).toBeGreaterThan(0);
    expect(chain.get('p2')!.saldoAFavor).toBeLessThan(0);
    expect(chain.get('p2')!.montoDistribuir).toBe(0);
    // La deuda del mes negativo se arrastra y se cubre en el siguiente.
    expect(chain.get('p2')!.deudaArrastradaSalida).toBe(26_000);
    expect(chain.get('p3')!.deudaArrastradaEntrada).toBe(26_000);
    // Reserva del 25% sobre el remanente ya neto de deuda.
    const p3 = chain.get('p3')!;
    const remanente = p3.saldoAFavor - p3.deudaArrastradaEntrada;
    expect(p3.reserveThisPeriod).toBeCloseTo(remanente * 0.25, 2);
    expect(p3.montoDistribuir).toBeCloseTo(remanente * 0.75, 2);
  });
});

describe('contrato — el forecast corre LA MISMA cadena, no una propia', () => {
  // projectCashflow recibe los insumos del builder y appendea meses
  // sintéticos. Si el forecast recalculara ingresos/egresos/reserva por su
  // cuenta, el arrastre desde el último mes real no coincidiría.
  const history = buildDistributionInputs(periods, sources) as RealMonth[];

  it('los insumos del builder son historia válida para el forecast', () => {
    // Contrato de tipos hecho aserción: si el builder deja de emitir
    // year/month/label/isClosed, el forecast se queda sin historia.
    for (const m of history) {
      expect(typeof m.year).toBe('number');
      expect(typeof m.month).toBe('number');
      expect(typeof m.label).toBe('string');
      expect(typeof m.isClosed).toBe('boolean');
    }
  });

  it('el mes proyectado sale de la cadena corrida sobre la historia real', () => {
    const res = projectCashflow(history, { monthsAhead: 1, sampleSize: 3, scenario: 'base' });
    const proyectado = res.months[0];

    // Reconstrucción manual del mismo mes sintético que arma el forecast.
    const sample = history.slice(-3);
    const avgIncome = sample.reduce((s, m) => s + incomeOf(m), 0) / sample.length;
    const avgExpenses = sample.reduce((s, m) => s + m.totalExpenses, 0) / sample.length;
    const sintetico: PeriodDistInput = {
      periodId: 'manual',
      brokerPnl: Math.round((avgIncome + Number.EPSILON) * 100) / 100,
      other: 0,
      propFirmNetIncome: 0,
      investmentProfits: 0,
      totalExpenses: Math.round((avgExpenses + Number.EPSILON) * 100) / 100,
      reservePct: history[history.length - 1].reservePct,
    };
    const esperado = computeDistributionChain([...history, sintetico]).get('manual')!;

    expect(proyectado.saldo).toBe(esperado.saldoAFavor);
    expect(proyectado.reserve).toBe(esperado.reserveThisPeriod);
    expect(proyectado.distribuir).toBe(esperado.montoDistribuir);
    expect(proyectado.debtOut).toBe(esperado.deudaArrastradaSalida);
  });

  it('la cadena de los meses REALES es idéntica en los dos caminos', () => {
    // El forecast corre computeDistributionChain sobre [...history, ...proyectados].
    // Los meses reales tienen que dar exactamente lo mismo que el camino
    // producto (builder + overrides + cadena) — appendear futuro no puede
    // mover el pasado.
    const producto = productChain();
    const conForecast = computeDistributionChain([
      ...applySnapshotOverrides(periods, history).inputs,
      {
        periodId: 'futuro',
        brokerPnl: 999,
        other: 0,
        propFirmNetIncome: 0,
        investmentProfits: 0,
        totalExpenses: 0,
        reservePct: 0.1,
      },
    ]);
    for (const id of ['p1', 'p2', 'p3']) {
      expect(conForecast.get(id), id).toEqual(producto.get(id));
    }
  });
});

describe('contrato — el cierre congela, y congela en los dos caminos', () => {
  // p2 cerrado con un snapshot que NO coincide con las tablas vivas: alguien
  // editó el pasado. La cadena tiene que ignorar lo vivo.
  const congelados: TestPeriod[] = periods.map(p =>
    p.id === 'p2'
      ? {
          ...p,
          closing_snapshot: {
            broker_pnl: 40_000,
            other_income: 0,
            prop_firm_sales: 0,
            prop_firm_withdrawals: 0,
            investment_profits: 0,
            total_expenses: 30_000,
            reserve_pct: 0.1,
          },
        }
      : p,
  );

  it('el mes cerrado usa el snapshot, no las tablas vivas', () => {
    const vivo = productChain(periods).get('p2')!;
    const frozen = productChain(congelados).get('p2')!;
    // Vivo: 4.000 − 30.000 = mes negativo. Congelado: 40.000 − 30.000 = +10.000.
    expect(vivo.saldoAFavor).toBe(-26_000);
    expect(frozen.saldoAFavor).toBe(10_000);
    expect(frozen.montoDistribuir).toBe(9_000); // 10% de reserva
  });

  it('el congelado también manda para el forecast (mismo override)', () => {
    const live = buildDistributionInputs(congelados, sources);
    const { inputs, drifts } = applySnapshotOverrides(congelados, live);
    const p2 = inputs.find(i => i.periodId === 'p2')!;
    expect(p2.brokerPnl).toBe(40_000);
    // Y la edición retroactiva no pasa desapercibida.
    expect(drifts.some(d => d.periodId === 'p2' && d.field === 'brokerPnl')).toBe(true);
  });

  it('el mes ABIERTO nunca se congela aunque traiga snapshot', () => {
    const abiertoConSnapshot = congelados.map(p =>
      p.id === 'p2' ? { ...p, is_closed: false } : p,
    );
    expect(productChain(abiertoConSnapshot).get('p2')!.saldoAFavor).toBe(-26_000);
  });
});

describe('contrato — el modelo de negocio entra por un solo lugar', () => {
  it("'company' apaga brokerPnl, prop firm e inversiones en TODA la cadena", () => {
    const broker = productChain(periods, { ...sources, businessModel: 'broker' });
    const company = productChain(periods, { ...sources, businessModel: 'company' });

    // p1 broker: 50.000 + 5.000 + (3.000 − 1.000) = 57.000
    expect(broker.get('p1')!.ingresosNetos).toBe(57_000);
    // p1 company: solo `other` (lo facturado y cobrado).
    expect(company.get('p1')!.ingresosNetos).toBe(5_000);
    // p3 broker incluye la ganancia de inversiones (80.000 + 2.000 + 1.500);
    // company no, porque el módulo Inversiones no existe para ese modelo.
    expect(broker.get('p3')!.ingresosNetos).toBe(83_500);
    expect(company.get('p3')!.ingresosNetos).toBe(2_000);
    // Y el mes que era normal pasa a negativo ⇒ no reparte plata fantasma.
    expect(broker.get('p1')!.montoDistribuir).toBeGreaterThan(0);
    expect(company.get('p1')!.montoDistribuir).toBe(0);
  });

  it("'company' resta lo PAGADO y 'broker' lo DEVENGADO, en TODA la cadena", () => {
    const broker = productChain(periods, { ...sources, businessModel: 'broker' });
    const company = productChain(periods, { ...sources, businessModel: 'company' });

    // p1: 12.000 facturados, 9.000 salidos de la caja.
    expect(broker.get('p1')!.egresosNetos).toBe(12_000);
    expect(company.get('p1')!.egresosNetos).toBe(9_000);
    // Los meses con todo pagado dan igual en los dos modelos.
    expect(company.get('p2')!.egresosNetos).toBe(broker.get('p2')!.egresosNetos);
  });
});
