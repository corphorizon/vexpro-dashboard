// /periodos: estado (is_closed primero), color = significado, cierre por/cuándo
// sólo si está cerrado, reserva sin inventar 0 %, y checklist → kinds.
import { describe, it, expect } from 'vitest';
import { CHECKLIST_LABEL_KEYS } from '@/lib/period-close-checklist';
import {
  PERIOD_STATUSES,
  PERIOD_STATUS_KIND,
  buildPeriodRows,
  checklistRows,
  checklistSummary,
  periodStatus,
  periodStatusCounts,
  reservePercent,
  type ChecklistApiItem,
  type PeriodWithClose,
} from './periods-view';

const NOW = new Date(2026, 9, 12); // 12 oct 2026, hora local

function period(p: Partial<PeriodWithClose>): PeriodWithClose {
  return {
    id: `${p.year ?? 2026}-${p.month ?? 1}`,
    company_id: 'c1',
    year: 2026,
    month: 1,
    label: null,
    is_closed: false,
    reserve_pct: 0.1,
    ...p,
  };
}

describe('periodStatus', () => {
  it('el mes actual abierto está «en curso»; otro mes abierto, «abierto»', () => {
    expect(periodStatus({ year: 2026, month: 10, is_closed: false }, NOW)).toBe('in_progress');
    expect(periodStatus({ year: 2026, month: 9, is_closed: false }, NOW)).toBe('open');
  });

  it('is_closed gana SIEMPRE, también en el mes actual (si no, quedaba irreabrible)', () => {
    expect(periodStatus({ year: 2026, month: 10, is_closed: true }, NOW)).toBe('closed');
  });

  it('mismo mes de otro año no está en curso', () => {
    expect(periodStatus({ year: 2025, month: 10, is_closed: false }, NOW)).toBe('open');
  });
});

describe('color = significado', () => {
  it('Abierto pend, En curso info, Cerrado neutro — y ninguno es «ok» (verde)', () => {
    expect(PERIOD_STATUS_KIND).toEqual({ open: 'pend', in_progress: 'info', closed: 'neutral' });
    for (const s of PERIOD_STATUSES) expect(PERIOD_STATUS_KIND[s]).not.toBe('ok');
  });
});

describe('buildPeriodRows', () => {
  const periods = [
    period({ id: 'jul', month: 7, label: 'Jul 26', is_closed: true, closed_at: '2026-08-03T14:00:00Z', closed_by_name: ' Kevin ' }),
    period({ id: 'ago', month: 8, label: 'Ago 26', is_closed: false, closed_at: '2026-09-02T10:00:00Z', closed_by_name: 'Ana', reserve_pct: 0.25 }),
    period({ id: 'oct', month: 10, label: 'Oct 26' }),
    period({ id: 'feb', month: 2, label: 'Feb 26', is_closed: true }),
  ];

  it('el más reciente primero', () => {
    expect(buildPeriodRows(periods, NOW).map((r) => r.id)).toEqual(['oct', 'ago', 'jul', 'feb']);
  });

  it('cerrado por / cuándo sólo si está cerrado (reabrir no limpia esos campos en la base)', () => {
    const rows = Object.fromEntries(buildPeriodRows(periods, NOW).map((r) => [r.id, r]));
    expect(rows.jul).toMatchObject({ status: 'closed', closedBy: 'Kevin', closedAt: '2026-08-03T14:00:00Z' });
    // Ago fue cerrado y REABIERTO: no se muestra el cierre viejo como vigente.
    expect(rows.ago).toMatchObject({ status: 'open', closedBy: null, closedAt: null });
  });

  it('un mes cerrado antes de la migración 061 no tiene quién/cuándo: null, no inventado', () => {
    const feb = buildPeriodRows(periods, NOW).find((r) => r.id === 'feb')!;
    expect(feb).toMatchObject({ status: 'closed', closedBy: null, closedAt: null });
  });

  it('reserva en porcentaje', () => {
    const rows = Object.fromEntries(buildPeriodRows(periods, NOW).map((r) => [r.id, r]));
    expect(rows.jul.reservePct).toBe(10);
    expect(rows.ago.reservePct).toBe(25);
  });

  it('conteos por estado', () => {
    expect(periodStatusCounts(buildPeriodRows(periods, NOW))).toEqual({ open: 1, in_progress: 1, closed: 2 });
    expect(periodStatusCounts([])).toEqual({ open: 0, in_progress: 0, closed: 0 });
  });
});

describe('reservePercent', () => {
  it('fracción → %, con redondeo de coma flotante', () => {
    expect(reservePercent(0.1)).toBe(10);
    expect(reservePercent(0.07)).toBe(7);
    expect(reservePercent(0)).toBe(0);
  });

  it('sin dato es null («—»), nunca 0 %', () => {
    expect(reservePercent(null)).toBeNull();
    expect(reservePercent(undefined)).toBeNull();
    expect(reservePercent(Number.NaN)).toBeNull();
  });
});

describe('checklist de cierre → kinds', () => {
  const item = (p: Partial<ChecklistApiItem>): ChecklistApiItem => ({
    key: 'k',
    count: 0,
    detail: null,
    severity: 'warning',
    ...p,
  });

  it('bloqueante con conteo = bad; aviso con conteo = pend; en 0 = ok (aunque sea bloqueante)', () => {
    const rows = checklistRows([
      item({ key: 'expenses_no_proof', count: 3 }),
      item({ key: 'earlier_periods_open', count: 1, severity: 'blocking' }),
      item({ key: 'crm_drift', count: 0 }),
      item({ key: 'orders_approved_unpaid', count: 0, severity: 'blocking' }),
    ]);
    expect(rows.map((r) => [r.key, r.kind])).toEqual([
      ['earlier_periods_open', 'bad'],
      ['expenses_no_proof', 'pend'],
      ['crm_drift', 'ok'],
      ['orders_approved_unpaid', 'ok'],
    ]);
    expect(checklistSummary(rows)).toEqual({ bad: 1, pend: 1, ok: 2 });
  });

  it('un conteo inválido NO es ok: se trata como aviso', () => {
    const rows = checklistRows([item({ count: Number.NaN }), item({ count: -1 })]);
    expect(rows.map((r) => r.kind)).toEqual(['pend', 'pend']);
  });

  it('sin severidad (servidor viejo) con conteo es aviso, no bloqueo', () => {
    expect(checklistRows([item({ count: 2, severity: undefined })])[0].kind).toBe('pend');
  });

  it('los ítems del registro único, todos en 0, salen todos ok y en su orden', () => {
    const keys = Object.keys(CHECKLIST_LABEL_KEYS);
    const rows = checklistRows(keys.map((key) => item({ key })));
    expect(rows.map((r) => r.key)).toEqual(keys);
    expect(rows.every((r) => r.kind === 'ok')).toBe(true);
  });

  it('lista vacía: nada que mostrar', () => {
    expect(checklistRows([])).toEqual([]);
    expect(checklistSummary([])).toEqual({ bad: 0, pend: 0, ok: 0 });
  });
});
