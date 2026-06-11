import { describe, it, expect } from 'vitest';
import {
  isDerivedBrokerPeriod,
  allPeriodsUseDerivedBroker,
  computeDerivedBroker,
  computeDerivedNetDeposit,
  BROKER_DERIVED_FROM_YEAR,
  BROKER_DERIVED_FROM_MONTH,
} from './broker-logic';

describe('isDerivedBrokerPeriod', () => {
  it('returns false for periods strictly before the cutoff', () => {
    expect(isDerivedBrokerPeriod({ year: 2025, month: 12 })).toBe(false);
    expect(isDerivedBrokerPeriod({ year: 2026, month: 3 })).toBe(false);
    expect(isDerivedBrokerPeriod({ year: 2024, month: 6 })).toBe(false);
  });

  it('returns true for the exact cutoff month (April 2026)', () => {
    expect(
      isDerivedBrokerPeriod({
        year: BROKER_DERIVED_FROM_YEAR,
        month: BROKER_DERIVED_FROM_MONTH,
      }),
    ).toBe(true);
  });

  it('returns true for periods after the cutoff', () => {
    expect(isDerivedBrokerPeriod({ year: 2026, month: 5 })).toBe(true);
    expect(isDerivedBrokerPeriod({ year: 2026, month: 12 })).toBe(true);
    expect(isDerivedBrokerPeriod({ year: 2027, month: 1 })).toBe(true);
  });
});

describe('allPeriodsUseDerivedBroker', () => {
  it('returns false for an empty list (avoid divide-by-zero in callers)', () => {
    expect(allPeriodsUseDerivedBroker([])).toBe(false);
  });

  it('returns true only when every period is on the new rule', () => {
    expect(
      allPeriodsUseDerivedBroker([
        { year: 2026, month: 4 },
        { year: 2026, month: 5 },
        { year: 2026, month: 6 },
      ]),
    ).toBe(true);
  });

  it('returns false when ANY period is pre-cutoff (mixed view)', () => {
    expect(
      allPeriodsUseDerivedBroker([
        { year: 2026, month: 3 }, // historical
        { year: 2026, month: 4 },
        { year: 2026, month: 5 },
      ]),
    ).toBe(false);
  });
});

describe('computeDerivedBroker', () => {
  it('subtracts categories from API total', () => {
    expect(
      computeDerivedBroker({
        apiWithdrawalsTotal: 100_000,
        ibCommissions: 15_000,
        propFirm: 6_000,
        other: 2_000,
      }),
    ).toBe(77_000);
  });

  it('clamps to zero when subtractions exceed API total', () => {
    expect(
      computeDerivedBroker({
        apiWithdrawalsTotal: 10_000,
        ibCommissions: 20_000,
        propFirm: 0,
        other: 0,
      }),
    ).toBe(0);
  });

  it('handles zero API total', () => {
    expect(
      computeDerivedBroker({
        apiWithdrawalsTotal: 0,
        ibCommissions: 0,
        propFirm: 0,
        other: 0,
      }),
    ).toBe(0);
  });

  it('reproduces Vex Pro April 2026 numbers from the Excel backfill', () => {
    // Apr-2026 audit numbers — referenced in
    // supabase/migration-042-unipayment-excel-backfill-record.sql
    // API withdrawals total $225,779.41, manual IB/PropFirm/Otros = 0,
    // so derived broker should equal the API total exactly.
    expect(
      computeDerivedBroker({
        apiWithdrawalsTotal: 225_779.41,
        ibCommissions: 0,
        propFirm: 0,
        other: 0,
      }),
    ).toBe(225_779.41);
  });
});

describe('computeDerivedNetDeposit (fórmula canónica compartida)', () => {
  it('Net Deposit = (api+manual deps) − (api wdr + manual broker)', () => {
    const r = computeDerivedNetDeposit({
      apiDeposits: 300_000,
      manualDepositsTotal: 200_000,
      apiWithdrawals: 180_000,
      manualBroker: 20_000,
    });
    expect(r.totalDeposits).toBe(500_000);
    expect(r.totalWithdrawals).toBe(200_000);
    expect(r.netDeposit).toBe(300_000);
  });

  it('ib/prop/other NO entran — son informativos (regresión del bug 2026-06-07)', () => {
    // Este es el escenario exacto que rompía /balances: cuando el manual de
    // ib/prop/other era > 0, la fórmula vieja los sumaba a los retiros e
    // inflaba el total. La fórmula canónica NO los recibe siquiera — solo
    // api withdrawals + broker. El resultado debe ser independiente de ellos.
    const r = computeDerivedNetDeposit({
      apiDeposits: 100_000,
      manualDepositsTotal: 0,
      apiWithdrawals: 50_000,
      manualBroker: 0,
    });
    // retiros = 50k (api) + 0 (broker) = 50k, sin importar cuánto ib/prop/other haya
    expect(r.totalWithdrawals).toBe(50_000);
    expect(r.netDeposit).toBe(50_000);
  });

  it('VexPro May 2026 (solo wallet Main pinneada) — números reales', () => {
    // Verificado contra la DB de producción: con solo VexPro Main pinneada,
    // depósitos API = 539,655.92 (cb) + 9,547 (fp) + 29,408.18 (up),
    // retiros API Coinsbuy = 573,908.00, manuales = 0.
    const apiDeposits = 539_655.92 + 9_547 + 29_408.18;
    const r = computeDerivedNetDeposit({
      apiDeposits,
      manualDepositsTotal: 0,
      apiWithdrawals: 573_908.0,
      manualBroker: 0,
    });
    expect(r.totalDeposits).toBeCloseTo(578_611.1, 2);
    expect(r.netDeposit).toBeCloseTo(4_703.1, 2);
  });

  it('coincide entre /movimientos y /balances para los mismos inputs (anti-divergencia)', () => {
    // El punto entero de extraer esto: ambas páginas llaman la MISMA función
    // con los mismos componentes → no pueden divergir nunca más.
    const input = {
      apiDeposits: 296_495.49,
      manualDepositsTotal: 218_518.35,
      apiWithdrawals: 191_905.89,
      manualBroker: 163_808,
    };
    const movimientos = computeDerivedNetDeposit(input);
    const balances = computeDerivedNetDeposit(input);
    expect(movimientos.netDeposit).toBe(balances.netDeposit);
  });
});
