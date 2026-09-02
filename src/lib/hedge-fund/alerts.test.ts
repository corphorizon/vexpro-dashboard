import { describe, it, expect } from 'vitest';
import { buildHedgeFundAlerts, HF_PAYOUT_ALERT_FROM_YM } from './alerts';
import { NOTIFICATION_KEYS } from '@/lib/notifications/catalog';
import type { HfFundRow, HfInvestmentRow, HfPayoutRow, HfWithdrawalRequestRow } from './types';

const base = { company_id: 'c1', raw: {}, synced_at: '2026-09-02T00:00:00.000Z' };
const AHORA = new Date('2026-09-02T00:00:00.000Z');

const fondo = (o: Partial<HfFundRow> = {}): HfFundRow => ({
  ...base, fund_key: 'growth', name: 'Growth', subtitle: null, strategy: null,
  min_investment: null, holding_months: 12, expected_return_raw: '22-26%',
  expected_return_min_pct: 22, expected_return_max_pct: 26, risk: null, currency: 'USD',
  enabled: true, status: 'OPEN', approval_mode: 'AUTO', close_date: null, slots_total: null,
  profits_locked: null, min_remaining_balance: null, source_created_at: null,
  source_updated_at: null, ...o,
});

const inv = (o: Partial<HfInvestmentRow> = {}): HfInvestmentRow => ({
  ...base, investment_id: 'i1', ref: null, user_external_id: 'u1', fund_key: 'growth',
  program: null, invested: 1000, principal: 1000, balance: 1000, currency: 'USD',
  holding_months: 12, start_date: null, end_date: '2027-01-01T00:00:00.000Z',
  status: 'ACTIVE', accepted_tc: null, approved_at: '2026-01-01T00:00:00.000Z',
  approved_by: null, rejected_at: null, rejected_by: null, rejected_reason: null,
  closed_at: null, closed_reason: null, source_created_at: null, source_updated_at: null, ...o,
});

const pay = (o: Partial<HfPayoutRow> = {}): HfPayoutRow => ({
  ...base, payout_id: 'p1', fund_key: 'growth', program: null, percent: 2, status: 'COMPLETED',
  accounts_affected: 1, total_credited: 20, currency: 'USD', executed_by: null,
  started_at: null, finished_at: '2026-09-01T00:00:00.000Z', source_created_at: null, ...o,
});

const req = (o: Partial<HfWithdrawalRequestRow> = {}): HfWithdrawalRequestRow => ({
  ...base, request_id: 'r1', investment_id: 'i1', user_external_id: 'u1', fund_key: 'growth',
  status: 'REQUESTED', type: null, amount: 500, currency: 'USD', requested_at: null,
  processed_at: null, source_created_at: null, source_updated_at: null, ...o,
});

const tipos = (input: Parameters<typeof buildHedgeFundAlerts>[0]) =>
  buildHedgeFundAlerts(input).map((a) => a.type);

describe('avisos del hedge fund', () => {
  // Sin esto, un aviso puede emitirse con una clave que el catálogo no conoce y
  // `notify` lo descarta en silencio: un aviso que nunca llega a nadie.
  it('cada tipo emitido existe en el catálogo único', () => {
    const alertas = buildHedgeFundAlerts({
      funds: [fondo({ approval_mode: 'MANUAL' })],
      investments: [inv({ end_date: '2026-09-10T00:00:00.000Z', approved_at: null })],
      payouts: [],
      withdrawalRequests: [req()],
      now: AHORA,
    });
    expect(alertas.length).toBeGreaterThan(0);
    for (const a of alertas) expect(NOTIFICATION_KEYS).toContain(a.type);
  });

  it('avisa por lo que vence en 30 días, con el capital sumado', () => {
    const alertas = buildHedgeFundAlerts({
      funds: [fondo()], payouts: [pay()], withdrawalRequests: [],
      investments: [
        inv({ investment_id: 'a', end_date: '2026-09-20T00:00:00.000Z', principal: 100 }),
        inv({ investment_id: 'b', end_date: '2026-12-20T00:00:00.000Z', principal: 900 }),
      ],
      now: AHORA,
    });
    const v = alertas.find((a) => a.type === 'hedge_fund.maturing_soon');
    expect(v?.params).toMatchObject({ count: 1, amount: '100.00', days: 30 });
  });

  it('lo YA VENCIDO y todavía abierto también entra: es lo más urgente', () => {
    const alertas = buildHedgeFundAlerts({
      funds: [fondo()], payouts: [pay()], withdrawalRequests: [],
      investments: [inv({ end_date: '2026-07-01T00:00:00.000Z', principal: 500 })],
      now: AHORA,
    });
    expect(alertas.find((a) => a.type === 'hedge_fund.maturing_soon')?.params.count).toBe(1);
  });

  it('sólo avisa por aprobación en fondos MANUAL y sin approvedAt', () => {
    const comun = { payouts: [pay()], withdrawalRequests: [], now: AHORA };
    // AUTO: no espera a nadie.
    expect(tipos({ ...comun, funds: [fondo({ approval_mode: 'AUTO' })], investments: [inv({ approved_at: null })] }))
      .not.toContain('hedge_fund.pending_approval');
    // MANUAL y ya aprobada: tampoco.
    expect(tipos({ ...comun, funds: [fondo({ approval_mode: 'MANUAL' })], investments: [inv()] }))
      .not.toContain('hedge_fund.pending_approval');
    // MANUAL, sin aprobar y abierta: sí.
    expect(tipos({ ...comun, funds: [fondo({ approval_mode: 'MANUAL' })], investments: [inv({ approved_at: null })] }))
      .toContain('hedge_fund.pending_approval');
  });

  it('una inversión en estado FINAL ya no espera aprobación', () => {
    for (const estado of ['REJECTED', 'TERMINATED', 'CANCELLED']) {
      expect(tipos({
        funds: [fondo({ approval_mode: 'MANUAL' })],
        investments: [inv({ approved_at: null, status: estado })],
        payouts: [pay()], withdrawalRequests: [], now: AHORA,
      })).not.toContain('hedge_fund.pending_approval');
    }
  });

  it('un estado de retiro DESCONOCIDO cuenta como pendiente y se ve', () => {
    // La lista es de RESUELTOS: un estado nuevo del CRM aparece en vez de
    // desaparecer, que es como `REVIEWED` dejó 8 retiros fuera de la cola.
    expect(tipos({
      funds: [fondo()], investments: [inv()], payouts: [pay()],
      withdrawalRequests: [req({ status: 'ALGO_NUEVO' })], now: AHORA,
    })).toContain('hedge_fund.withdrawal_pending');
    expect(tipos({
      funds: [fondo()], investments: [inv()], payouts: [pay()],
      withdrawalRequests: [req({ status: 'COMPLETED' })], now: AHORA,
    })).not.toContain('hedge_fund.withdrawal_pending');
  });

  it('avisa del fondo con capital activo que no pagó este mes', () => {
    const alertas = buildHedgeFundAlerts({
      funds: [fondo()], investments: [inv()], withdrawalRequests: [],
      payouts: [pay({ finished_at: '2026-08-01T00:00:00.000Z' })],
      now: AHORA,
    });
    const a = alertas.find((x) => x.type === 'hedge_fund.no_payout_this_month');
    expect(a?.params).toEqual({ funds: 1, month: '2026-09' });
    // El mes va en el dedupe: septiembre no puede silenciar a octubre.
    expect(a?.dedupeSuffix).toBe('nopayout:2026-09');
  });

  it('con el pago del mes hecho, no avisa', () => {
    expect(tipos({
      funds: [fondo()], investments: [inv()], withdrawalRequests: [],
      payouts: [pay({ finished_at: '2026-09-01T00:00:00.000Z' })], now: AHORA,
    })).not.toContain('hedge_fund.no_payout_this_month');
  });

  it('antes de septiembre de 2026 no existe ese aviso', () => {
    // Kevin, 2026-09-02: los primeros rendimientos se pagan este mes. Antes
    // sería un falso positivo mensual.
    expect(HF_PAYOUT_ALERT_FROM_YM).toBe('2026-09');
    expect(tipos({
      funds: [fondo()], investments: [inv()], withdrawalRequests: [], payouts: [],
      now: new Date('2026-08-15T00:00:00.000Z'),
    })).not.toContain('hedge_fund.no_payout_this_month');
  });

  it('sin nada que avisar devuelve una lista vacía', () => {
    expect(buildHedgeFundAlerts({
      funds: [fondo()],
      investments: [inv({ end_date: '2028-01-01T00:00:00.000Z' })],
      payouts: [pay()], withdrawalRequests: [], now: AHORA,
    })).toEqual([]);
  });
});
