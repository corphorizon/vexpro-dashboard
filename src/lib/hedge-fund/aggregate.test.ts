import { describe, it, expect } from 'vitest';
import {
  bucketMaturities,
  buildFundSummaries,
  buildMaturityCalendar,
  buildOverview,
  daysUntil,
  monthKeyUtc,
  totalCommissions,
} from './aggregate';
import type { HfCommissionRow, HfFundRow, HfInvestmentRow, HfLedgerRow, HfPayoutRow } from './types';

const CO = 'c1';
const AT = '2026-09-02T00:00:00.000Z';
const base = { company_id: CO, raw: {}, synced_at: AT };

function fondo(over: Partial<HfFundRow> = {}): HfFundRow {
  return {
    ...base, fund_key: 'growth', name: 'Growth', subtitle: null, strategy: null,
    min_investment: 1000, holding_months: 12, expected_return_raw: '22-26%',
    expected_return_min_pct: 22, expected_return_max_pct: 26, risk: 'medium',
    currency: 'USD', enabled: true, status: 'OPEN', approval_mode: 'AUTO',
    close_date: null, slots_total: null, profits_locked: false,
    min_remaining_balance: null, source_created_at: null, source_updated_at: null,
    ...over,
  };
}

function inversion(over: Partial<HfInvestmentRow> = {}): HfInvestmentRow {
  return {
    ...base, investment_id: 'i1', ref: '#HF-1021', user_external_id: 'u1',
    fund_key: 'growth', program: 'Growth', invested: 1000, principal: 1000,
    balance: 1100, currency: 'USD', holding_months: 12,
    start_date: '2026-01-01T00:00:00.000Z', end_date: '2027-01-01T00:00:00.000Z',
    status: 'ACTIVE', accepted_tc: true, approved_at: '2026-01-01T00:00:00.000Z',
    approved_by: null, rejected_at: null, rejected_by: null, rejected_reason: null,
    closed_at: null, closed_reason: null, source_created_at: null, source_updated_at: null,
    ...over,
  };
}

function asiento(over: Partial<HfLedgerRow> = {}): HfLedgerRow {
  return {
    ...base, entry_id: 'e1', investment_id: 'i1', user_external_id: 'u1',
    fund_key: 'growth', type: 'PAYOUT', amount: 100, balance_before: 1000,
    balance_after: 1100, currency: 'USD', payout_id: 'p1', description: null,
    source_created_at: '2026-09-01T00:00:00.000Z', ...over,
  };
}

function comision(over: Partial<HfCommissionRow> = {}): HfCommissionRow {
  return {
    ...base, commission_id: 'c1', type: 'DIRECT', beneficiary_user_external_id: 'b1',
    beneficiary_username: 'benja', source_user_external_id: 'u1', source_username: 'cliente',
    investment_id: 'i1', fund_key: 'growth', level: 1, percent: 5, base_amount: 1000,
    amount: 50, currency: 'USD', ym: null, status: 'PAID', paid_at: '2026-09-01T00:00:00.000Z',
    source_created_at: null, ...over,
  };
}

function payout(over: Partial<HfPayoutRow> = {}): HfPayoutRow {
  return {
    ...base, payout_id: 'p1', fund_key: 'growth', program: 'Growth', percent: 2,
    status: 'COMPLETED', accounts_affected: 1, total_credited: 100, currency: 'USD',
    executed_by: 'kevin', started_at: '2026-09-01T00:00:00.000Z',
    finished_at: '2026-09-01T00:10:00.000Z', source_created_at: null, ...over,
  };
}

describe('comisiones de red', () => {
  it('el reverso se cuenta aparte y el neto NO se clampea a cero', () => {
    // §2.1 regla #1: una comisión negativa ES deuda; llevarla a 0 la borra.
    const t = totalCommissions([
      comision({ commission_id: 'a', amount: 50 }),
      comision({ commission_id: 'b', amount: -80 }),
    ]);
    expect(t).toEqual({ paid: 50, reversed: 80, net: -30, count: 2, reversedCount: 1 });
  });

  it('un importe null se saltea: no es cero', () => {
    const t = totalCommissions([comision({ amount: null })]);
    expect(t.paid).toBe(0);
    expect(t.count).toBe(1);
  });
});

describe('resumen por programa', () => {
  const funds = [fondo(), fondo({ fund_key: 'safe', name: 'Safe', enabled: false })];
  const investments = [
    inversion({ investment_id: 'i1', user_external_id: 'u1', balance: 1100, principal: 1000 }),
    inversion({ investment_id: 'i2', user_external_id: 'u1', balance: 900, principal: 900 }),
    // Terminada: NO cuenta como capital vivo.
    inversion({ investment_id: 'i3', user_external_id: 'u9', status: 'TERMINATED', balance: 0, principal: 5000 }),
  ];

  it('el AUM sale del saldo de las ACTIVE y NO cuenta las terminadas', () => {
    const [growth] = buildFundSummaries({ funds, investments, ledger: [], payouts: [] });
    expect(growth.aum).toBe(2000);
    expect(growth.principal).toBe(1900);
    expect(growth.activeInvestments).toBe(2);
    expect(growth.totalInvestments).toBe(3);
  });

  it('cuenta clientes DISTINTOS, no inversiones', () => {
    const [growth] = buildFundSummaries({ funds, investments, ledger: [], payouts: [] });
    expect(growth.clients).toBe(1);
  });

  it('el ticket promedio es null —no 0— sin inversiones activas', () => {
    const [, safe] = buildFundSummaries({ funds, investments, ledger: [], payouts: [] });
    expect(safe.activeInvestments).toBe(0);
    expect(safe.averageTicket).toBeNull();
  });

  it('un fondo deshabilitado SE MUESTRA igual (los cinco de Vex Pro)', () => {
    const resumen = buildFundSummaries({ funds, investments, ledger: [], payouts: [] });
    expect(resumen.map((f) => f.fundKey)).toEqual(['growth', 'safe']);
    expect(resumen[1].enabled).toBe(false);
  });

  it('toma la corrida de pago MÁS RECIENTE', () => {
    const [growth] = buildFundSummaries({
      funds, investments, ledger: [],
      payouts: [
        payout({ payout_id: 'viejo', finished_at: '2026-07-01T00:00:00.000Z', percent: 1 }),
        payout({ payout_id: 'nuevo', finished_at: '2026-09-01T00:00:00.000Z', percent: 2 }),
      ],
    });
    expect(growth.lastPayoutPercent).toBe(2);
  });
});

describe('vencimientos', () => {
  const ahora = new Date('2026-09-02T00:00:00.000Z');

  it('los días restantes son negativos cuando ya venció', () => {
    expect(daysUntil('2026-08-02T00:00:00.000Z', ahora)).toBe(-31);
    expect(daysUntil(null, ahora)).toBeNull();
  });

  it('los tramos son ACUMULATIVOS: lo de 30 también está en 60 y en 90', () => {
    const invs = [
      inversion({ investment_id: 'a', end_date: '2026-09-20T00:00:00.000Z', principal: 100 }),
      inversion({ investment_id: 'b', end_date: '2026-10-20T00:00:00.000Z', principal: 200 }),
      inversion({ investment_id: 'c', end_date: '2026-11-20T00:00:00.000Z', principal: 400 }),
      // Vencida y todavía abierta: es el caso más urgente y va aparte.
      inversion({ investment_id: 'd', end_date: '2026-08-01T00:00:00.000Z', principal: 800 }),
    ];
    const b = bucketMaturities(invs, ahora);
    expect(b.overdue).toEqual({ count: 1, principal: 800 });
    expect(b.in30).toEqual({ count: 1, principal: 100 });
    expect(b.in60).toEqual({ count: 2, principal: 300 });
    expect(b.in90).toEqual({ count: 3, principal: 700 });
  });

  it('una TERMINATED no vuelve a vencer', () => {
    const b = bucketMaturities(
      [inversion({ status: 'TERMINATED', end_date: '2026-09-10T00:00:00.000Z', principal: 999 })],
      ahora,
    );
    expect(b.in30).toEqual({ count: 0, principal: 0 });
  });

  it('el mes se toma en UTC: el día 1 no se corre al mes anterior', () => {
    expect(monthKeyUtc('2026-10-01T00:30:00.000Z')).toBe('2026-10');
  });
});

describe('calendario de vencimientos con proyección', () => {
  it('proyecta al retorno esperado del fondo y prorratea por permanencia', () => {
    const meses = buildMaturityCalendar(
      [inversion({ principal: 10_000, holding_months: 6, end_date: '2027-01-15T00:00:00.000Z' })],
      [fondo()],
    );
    expect(meses).toHaveLength(1);
    expect(meses[0].ym).toBe('2027-01');
    expect(meses[0].principal).toBe(10_000);
    expect(meses[0].projected).toEqual({ min: 1100, max: 1300 });
    expect(meses[0].withoutProjection).toBe(0);
  });

  it('un fondo sin retorno parseable deja el mes SIN proyección y lo CUENTA', () => {
    // `null` y no 0: un 0 diría «ese mes no rinde nada».
    const meses = buildMaturityCalendar(
      [inversion({ fund_key: 'raro' })],
      [fondo({ fund_key: 'raro', expected_return_raw: 'a definir', expected_return_min_pct: null, expected_return_max_pct: null })],
    );
    expect(meses[0].projected).toBeNull();
    expect(meses[0].withoutProjection).toBe(1);
  });

  it('mezcla: proyecta lo que puede y cuenta lo que no', () => {
    const meses = buildMaturityCalendar(
      [
        inversion({ investment_id: 'a', principal: 1000, holding_months: 12 }),
        inversion({ investment_id: 'b', fund_key: 'raro', principal: 1000, holding_months: 12 }),
      ],
      [fondo({ expected_return_min_pct: 10, expected_return_max_pct: 10, expected_return_raw: '10%' }),
       fondo({ fund_key: 'raro', expected_return_raw: null, expected_return_min_pct: null, expected_return_max_pct: null })],
    );
    expect(meses[0].principal).toBe(2000);
    expect(meses[0].projected).toEqual({ min: 100, max: 100 });
    expect(meses[0].withoutProjection).toBe(1);
  });

  it('ordena los meses cronológicamente', () => {
    const meses = buildMaturityCalendar(
      [
        inversion({ investment_id: 'a', end_date: '2027-03-01T00:00:00.000Z' }),
        inversion({ investment_id: 'b', end_date: '2027-01-01T00:00:00.000Z' }),
      ],
      [fondo()],
    );
    expect(meses.map((m) => m.ym)).toEqual(['2027-01', '2027-03']);
  });
});

describe('overview', () => {
  it('el pasivo con clientes es principal + rendimientos acreditados', () => {
    const o = buildOverview({
      investments: [inversion({ principal: 1000, balance: 1100 })],
      ledger: [asiento({ amount: 100 })],
      commissions: [comision({ amount: 50 })],
      now: new Date('2026-09-02T00:00:00.000Z'),
    });
    expect(o.liabilityPrincipal).toBe(1000);
    expect(o.liabilityCreditedReturns).toBe(100);
    expect(o.clientLiability).toBe(1100);
    // Y el AUM se expone aparte, para que una separación entre los dos se VEA.
    expect(o.aum).toBe(1100);
    expect(o.commissions.net).toBe(50);
  });

  it('sólo los asientos PAYOUT cuentan como rendimiento acreditado', () => {
    const o = buildOverview({
      investments: [inversion()],
      ledger: [asiento({ amount: 100 }), asiento({ entry_id: 'e2', type: 'TERMINATION', amount: -1000 })],
      commissions: [],
    });
    expect(o.creditedReturns).toBe(100);
  });
});
