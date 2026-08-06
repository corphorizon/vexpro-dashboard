import { describe, it, expect } from 'vitest';
import { projectCashflow, incomeOf, type RealMonth } from './forecast';
import { computeDistributionChain } from './distribution';

const mes = (
  year: number, month: number, income: number, expenses: number,
  opts: Partial<RealMonth> = {},
): RealMonth => ({
  periodId: `p-${year}-${month}`,
  year, month,
  label: `${month}/${year}`,
  isClosed: true,
  brokerPnl: income,
  other: 0,
  propFirmNetIncome: 0,
  investmentProfits: 0,
  totalExpenses: expenses,
  reservePct: 0.1,
  ...opts,
});

describe('projectCashflow', () => {
  const history = [
    mes(2026, 5, 100_000, 60_000),
    mes(2026, 6, 120_000, 70_000),
    mes(2026, 7, 110_000, 65_000),
    // Mes en curso, abierto y a medias — no debe contaminar el promedio.
    mes(2026, 8, 20_000, 10_000, { isClosed: false }),
  ];

  it('promedia solo los meses cerrados', () => {
    const f = projectCashflow(history);
    expect(f.assumptions.avgIncome).toBe(110_000); // (100+120+110)/3
    expect(f.assumptions.avgExpenses).toBe(65_000);
    expect(f.assumptions.sampleMonths).toEqual(['5/2026', '6/2026', '7/2026']);
  });

  it('proyecta a partir del último mes real, cruzando el fin de año', () => {
    const f = projectCashflow([mes(2026, 11, 100, 50), mes(2026, 12, 100, 50)], { monthsAhead: 3 });
    expect(f.months.map((m) => `${m.month}/${m.year}`)).toEqual(['1/2027', '2/2027', '3/2027']);
  });

  it('el escenario ajusta SOLO los ingresos', () => {
    const base = projectCashflow(history, { scenario: 'base' });
    const pes = projectCashflow(history, { scenario: 'pesimista' });
    expect(pes.months[0].income).toBeCloseTo(base.months[0].income * 0.8, 2);
    expect(pes.months[0].expenses).toBe(base.months[0].expenses);
  });

  // El invariante que justifica el diseño: los meses proyectados salen de LA
  // MISMA fórmula que /socios, con el arrastre real. Si alguien reemplaza la
  // cadena por un cálculo paralelo "de forecast", este test lo delata.
  it('usa la fórmula real de distribución con el arrastre de la historia', () => {
    const f = projectCashflow(history, { monthsAhead: 2, scenario: 'base' });

    const projected = f.months.map((m, i) => ({
      periodId: `forecast-${m.year}-${m.month}`,
      brokerPnl: f.assumptions.avgIncome,
      other: 0,
      propFirmNetIncome: 0,
      investmentProfits: 0,
      totalExpenses: f.assumptions.avgExpenses,
      reservePct: 0.1 as number | null,
      _i: i,
    }));
    const chain = computeDistributionChain([...history, ...projected]);
    for (const m of f.months) {
      const r = chain.get(`forecast-${m.year}-${m.month}`)!;
      expect(m.distribuir).toBe(r.montoDistribuir);
      expect(m.reserve).toBe(r.reserveThisPeriod);
    }
  });

  it('la deuda del mes en curso se arrastra a la proyección', () => {
    // Mes abierto muy negativo: la proyección arranca pagando esa deuda.
    const conDeuda = [
      mes(2026, 6, 100_000, 60_000),
      mes(2026, 7, 100_000, 60_000),
      mes(2026, 8, 0, 50_000, { isClosed: false }), // −50.000
    ];
    const f = projectCashflow(conDeuda, { monthsAhead: 1, scenario: 'base' });
    const sinDeuda = projectCashflow(conDeuda.slice(0, 2), { monthsAhead: 1, scenario: 'base' });
    // Con la deuda de agosto en el medio, lo distribuible del mes proyectado
    // tiene que ser menor que sin ella.
    expect(f.months[0].distribuir).toBeLessThan(sinDeuda.months[0].distribuir);
  });

  it('historial vacío devuelve proyección vacía sin romper', () => {
    const f = projectCashflow([]);
    expect(f.months).toEqual([]);
  });
});

describe('incomeOf', () => {
  it('suma las cuatro fuentes de ingreso', () => {
    expect(incomeOf({
      periodId: 'x', brokerPnl: 100, other: 20, propFirmNetIncome: 30,
      investmentProfits: 50, totalExpenses: 0, reservePct: 0.1,
    })).toBe(200);
  });
});
