import { describe, expect, it } from 'vitest';
import type { QueueItem } from '@/lib/withdrawal-risk/api';
import {
  displayCurrency,
  factorTally,
  filterQueueRows,
  isStale,
  methodCounts,
  primaryDecision,
  queueKpis,
  queueSection,
  sectionCounts,
  sumAmounts,
  urgentQueue,
} from './queue-view';

type Band = 'low' | 'medium' | 'high';

function item(
  id: string,
  opts: { amount?: number | null; band?: Band; decision?: string | null; method?: string; age?: number | null } = {},
): QueueItem {
  return {
    withdrawal: { external_id: id, requested_amount: opts.amount === undefined ? 100 : opts.amount, coin: 'USDT' },
    paymentMethod: opts.method ?? 'USDT TRC20',
    ageDays: opts.age === undefined ? 1 : opts.age,
    score: { band: opts.band ?? 'low', approvalScore: 90, factors: [] },
    review: opts.decision ? { decision: opts.decision } : null,
  } as unknown as QueueItem;
}

describe('secciones Pendientes / Escalados', () => {
  it('escalado = última decisión `escalate`; todo lo demás es pendiente', () => {
    expect(queueSection(item('a', { decision: 'escalate' }))).toBe('escalated');
    expect(queueSection(item('b', { decision: 'approve' }))).toBe('pending');
    expect(queueSection(item('c'))).toBe('pending');
  });

  it('los dos conteos suman exactamente los solicitados', () => {
    const rows = [item('a', { decision: 'escalate' }), item('b'), item('c', { decision: 'reject' }), item('d', { decision: 'escalate' })];
    const c = sectionCounts(rows);
    expect(c).toEqual({ pending: 2, escalated: 2 });
    expect(c.pending + c.escalated).toBe(rows.length);
  });
});

describe('filtros de la cola', () => {
  const rows = [
    item('a', { method: 'USDT TRC20' }),
    item('b', { method: 'USDT TRC20', decision: 'escalate' }),
    item('c', { method: 'BTC' }),
    item('d', { method: '' }),
  ];

  it('methodCounts lista los métodos que HAY, de más a menos frecuente; vacío = «—»', () => {
    expect(methodCounts(rows)).toEqual([
      { method: 'USDT TRC20', count: 2 },
      { method: 'BTC', count: 1 },
      { method: '—', count: 1 },
    ]);
  });

  it('sección y método se combinan; null = sin filtro', () => {
    expect(filterQueueRows(rows, { section: null, method: null })).toHaveLength(4);
    expect(filterQueueRows(rows, { section: 'pending', method: 'USDT TRC20' }).map((r) => r.withdrawal.external_id)).toEqual(['a']);
    expect(filterQueueRows(rows, { section: 'escalated', method: null }).map((r) => r.withdrawal.external_id)).toEqual(['b']);
    expect(filterQueueRows(rows, { section: null, method: '—' }).map((r) => r.withdrawal.external_id)).toEqual(['d']);
  });
});

describe('totales: un monto null NO es 0', () => {
  it('suma los conocidos y cuenta los faltantes', () => {
    expect(sumAmounts([{ v: 10 }, { v: null }, { v: 5.5 }], (r) => r.v)).toEqual({ sum: 15.5, count: 3, missing: 1 });
  });
  it('sin ningún monto conocido la suma es null («—»), no 0', () => {
    expect(sumAmounts([{ v: null }], (r) => r.v)).toEqual({ sum: null, count: 1, missing: 1 });
    expect(sumAmounts([], (r: { v: number }) => r.v)).toEqual({ sum: null, count: 0, missing: 0 });
  });
  it('queueKpis: alta y paradas (≥ 7 d); antigüedad null no es «parado»', () => {
    const k = queueKpis([
      item('a', { amount: 100, band: 'high', age: 8 }),
      item('b', { amount: null, band: 'high', age: 2 }),
      item('c', { amount: 50, band: 'low', age: null }),
      item('d', { amount: 25, band: 'medium', age: 7 }),
    ]);
    expect(k.total).toEqual({ sum: 175, count: 4, missing: 1 });
    expect(k.high).toEqual({ sum: 100, count: 2, missing: 1 });
    expect(k.stale).toEqual({ sum: 125, count: 2, missing: 0 });
    expect(isStale(null)).toBe(false);
    expect(isStale(6.99)).toBe(false);
    expect(isStale(7)).toBe(true);
  });
});

describe('urgentQueue (dashboard)', () => {
  it('banda alta primero, después la más vieja; sin antigüedad al final de su banda', () => {
    const rows = [
      item('low-old', { band: 'low', age: 30 }),
      item('high-new', { band: 'high', age: 1 }),
      item('high-unknown', { band: 'high', age: null }),
      item('high-old', { band: 'high', age: 9 }),
      item('med', { band: 'medium', age: 3 }),
    ];
    expect(urgentQueue(rows, 4).map((r) => r.withdrawal.external_id)).toEqual([
      'high-old',
      'high-new',
      'high-unknown',
      'med',
    ]);
    // No muta la lista recibida.
    expect(rows[0].withdrawal.external_id).toBe('low-old');
  });
});

describe('ficha', () => {
  it('un solo primario, por rol y nunca por score', () => {
    expect(primaryDecision(true, true)).toBe('approve');
    expect(primaryDecision(false, true)).toBe('escalate');
    expect(primaryDecision(false, false)).toBeNull();
  });
  it('factorTally cuenta cuántos empujan a cada lado', () => {
    expect(factorTally([{ impact: 'down' }, { impact: 'up' }, { impact: 'down' }])).toEqual({ down: 2, up: 1, neutral: 0 });
  });
  it('displayCurrency: USDT se muestra como USD; sin moneda, la de la empresa', () => {
    expect(displayCurrency('USDT', 'EUR')).toBe('USD');
    expect(displayCurrency(null, 'EUR')).toBe('EUR');
    expect(displayCurrency(null, null)).toBe('USD');
    expect(displayCurrency('BTC', 'USD')).toBe('BTC');
  });
});
