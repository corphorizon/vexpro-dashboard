import { describe, it, expect } from 'vitest';
import { computeDistributionChain, type PeriodDistInput } from './distribution';

// Blinda la fórmula canónica de distribución a socios (BUG-01). Cubre los 4
// ejes que antes divergían entre /balances y /socios: reserva, investmentProfits,
// resta de egresos y modelo de mes negativo (deuda arrastrada + reserva-ahorro).

const base = (over: Partial<PeriodDistInput>): PeriodDistInput => ({
  periodId: 'p',
  brokerPnl: 0,
  other: 0,
  propFirmNetIncome: 0,
  investmentProfits: 0,
  totalExpenses: 0,
  reservePct: 0.1,
  ...over,
});

describe('computeDistributionChain — mes positivo simple', () => {
  it('reserva = remanente × pct; montoDistribuir = remanente − reserva', () => {
    const r = computeDistributionChain([
      base({ periodId: 'm1', brokerPnl: 100_000, totalExpenses: 0 }),
    ]).get('m1')!;
    expect(r.saldoAFavor).toBe(100_000);
    expect(r.reserveThisPeriod).toBe(10_000); // 10%
    expect(r.montoDistribuir).toBe(90_000);
    expect(r.reserveAccumulated).toBe(10_000);
    expect(r.deudaArrastradaSalida).toBe(0);
  });

  it('resta egresos de la base (saldo = ingresos − egresos)', () => {
    const r = computeDistributionChain([
      base({ periodId: 'm1', brokerPnl: 100_000, totalExpenses: 40_000 }),
    ]).get('m1')!;
    expect(r.saldoAFavor).toBe(60_000);
    expect(r.montoDistribuir).toBe(54_000); // 60k − 6k reserva
  });
});

describe('computeDistributionChain — investmentProfits ENTRA en la base (decisión Kevin 2026-07-12)', () => {
  it('suma investmentProfits al ingreso distribuible', () => {
    const sinInv = computeDistributionChain([
      base({ periodId: 'm1', brokerPnl: 50_000, investmentProfits: 0 }),
    ]).get('m1')!;
    const conInv = computeDistributionChain([
      base({ periodId: 'm1', brokerPnl: 50_000, investmentProfits: 20_000 }),
    ]).get('m1')!;
    expect(sinInv.montoDistribuir).toBe(45_000); // 50k − 5k
    expect(conInv.montoDistribuir).toBe(63_000); // 70k − 7k
  });

  it('incluye propFirmNetIncome y other también', () => {
    const r = computeDistributionChain([
      base({ periodId: 'm1', brokerPnl: 10_000, other: 5_000, propFirmNetIncome: 3_000, investmentProfits: 2_000 }),
    ]).get('m1')!;
    expect(r.ingresosNetos).toBe(20_000);
    expect(r.montoDistribuir).toBe(18_000);
  });
});

describe('computeDistributionChain — modelo de mes negativo (reserva-ahorro + carryDebt)', () => {
  it('mes negativo: no distribuye, reserva NO se drena, la pérdida se arrastra', () => {
    const chain = computeDistributionChain([
      base({ periodId: 'm1', brokerPnl: 100_000 }),      // +100k → reserva 10k, reparte 90k
      base({ periodId: 'm2', brokerPnl: 0, totalExpenses: 30_000 }), // −30k
    ]);
    const m2 = chain.get('m2')!;
    expect(m2.montoDistribuir).toBe(0);
    expect(m2.reserveAccumulated).toBe(10_000); // reserva del m1 intacta, NO drenada
    expect(m2.deudaArrastradaSalida).toBe(30_000); // pérdida arrastrada como deuda
  });

  it('mes positivo posterior cubre la deuda arrastrada ANTES de reservar/repartir', () => {
    const chain = computeDistributionChain([
      base({ periodId: 'm1', totalExpenses: 20_000 }),   // −20k → deuda 20k
      base({ periodId: 'm2', brokerPnl: 50_000 }),       // +50k, cubre 20k → remanente 30k
    ]);
    const m2 = chain.get('m2')!;
    expect(m2.deudaArrastradaEntrada).toBe(20_000);
    expect(m2.deudaArrastradaSalida).toBe(0);
    // remanente 30k → reserva 3k, reparte 27k
    expect(m2.reserveThisPeriod).toBe(3_000);
    expect(m2.montoDistribuir).toBe(27_000);
  });

  it('deuda mayor que el ingreso: se cubre parcial, no se distribuye, resta deuda', () => {
    const chain = computeDistributionChain([
      base({ periodId: 'm1', totalExpenses: 50_000 }),   // deuda 50k
      base({ periodId: 'm2', brokerPnl: 20_000 }),       // cubre 20k, queda deuda 30k
    ]);
    const m2 = chain.get('m2')!;
    expect(m2.deudaArrastradaSalida).toBe(30_000);
    expect(m2.montoDistribuir).toBe(0);
    expect(m2.reserveThisPeriod).toBe(0);
  });
});

describe('computeDistributionChain — robustez', () => {
  it('reservePct null usa 10% por defecto', () => {
    const r = computeDistributionChain([
      base({ periodId: 'm1', brokerPnl: 100_000, reservePct: null }),
    ]).get('m1')!;
    expect(r.reserveThisPeriod).toBe(10_000);
  });

  it('respeta un reservePct custom del período', () => {
    const r = computeDistributionChain([
      base({ periodId: 'm1', brokerPnl: 100_000, reservePct: 0.15 }),
    ]).get('m1')!;
    expect(r.reserveThisPeriod).toBe(15_000);
    expect(r.montoDistribuir).toBe(85_000);
  });

  it('redondea a 2 decimales (sin drift de float)', () => {
    const r = computeDistributionChain([
      base({ periodId: 'm1', brokerPnl: 33_333.33, reservePct: 0.1 }),
    ]).get('m1')!;
    // 33333.33 × 0.9 = 29999.997 → 30000.00 tras round2
    expect(r.montoDistribuir).toBe(30_000);
    expect(Number.isInteger(r.montoDistribuir * 100)).toBe(true);
  });
});
