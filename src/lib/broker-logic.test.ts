import { describe, it, expect } from 'vitest';
import {
  isDerivedBrokerPeriod,
  allPeriodsUseDerivedBroker,
  computeDerivedBroker,
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
