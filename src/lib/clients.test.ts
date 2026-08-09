import { describe, it, expect } from 'vitest';
import {
  clientKey,
  UNASSIGNED_CLIENT_KEY,
  cardsFromLines,
  totalsOf,
} from './clients';
import type { IncomeLine } from './income-lines';

let seq = 0;
type Row = IncomeLine & { periodLabel: string; periodOrder: number };
function row(partial: Partial<Row>): Row {
  seq += 1;
  return {
    id: `l${seq}`, company_id: 'c1', period_id: 'p1',
    concept: 'Servicio', client: 'Vex Pro',
    amount: 1000, received: 1000, pending: 0,
    category: null, reference: null, income_date: null, sort_order: seq,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    periodLabel: 'Ene 26', periodOrder: 2026 * 12 + 1,
    ...partial,
  };
}

describe('clientKey', () => {
  // Sin esto, "Vex Pro" y "vex pro" serían dos fichas distintas y la deuda
  // del cliente aparecería partida en dos.
  it('agrupa sin importar mayúsculas ni espacios', () => {
    expect(clientKey('Vex Pro')).toBe(clientKey('  vex pro '));
  });

  it('lo que no tiene cliente cae en una clave propia', () => {
    expect(clientKey(null)).toBe(UNASSIGNED_CLIENT_KEY);
    expect(clientKey('   ')).toBe(UNASSIGNED_CLIENT_KEY);
  });
});

describe('cardsFromLines', () => {
  it('suma facturado, cobrado y por cobrar del cliente', () => {
    const [card] = cardsFromLines([
      row({ client: 'Be Prime', amount: 6000, received: 0, pending: 6000 }),
      row({ client: 'Be Prime', amount: 2500, received: 2500, pending: 0 }),
    ]);
    expect(card.name).toBe('Be Prime');
    expect(card.amount).toBe(8500);
    expect(card.received).toBe(2500);
    expect(card.pending).toBe(6000);
  });

  it('parte el histórico por mes, del más reciente al más viejo', () => {
    const [card] = cardsFromLines([
      row({ period_id: 'p1', periodLabel: 'Ene 26', periodOrder: 24313, amount: 1000 }),
      row({ period_id: 'p2', periodLabel: 'Feb 26', periodOrder: 24314, amount: 2000 }),
      row({ period_id: 'p2', periodLabel: 'Feb 26', periodOrder: 24314, amount: 500 }),
    ]);
    expect(card.months.map((m) => m.periodLabel)).toEqual(['Feb 26', 'Ene 26']);
    expect(card.months[0].amount).toBe(2500);
    expect(card.months[0].lines).toHaveLength(2);
    expect(card.firstPeriodLabel).toBe('Ene 26');
    expect(card.lastPeriodLabel).toBe('Feb 26');
  });

  it('agrupa los conceptos y cuenta cuántas veces se facturaron', () => {
    const [card] = cardsFromLines([
      row({ concept: 'CRM', amount: 10_000 }),
      row({ concept: 'crm', amount: 10_000, period_id: 'p2', periodLabel: 'Feb 26', periodOrder: 24314 }),
      row({ concept: 'Legal', amount: 500 }),
    ]);
    expect(card.concepts[0]).toEqual({ concept: 'CRM', amount: 20_000, times: 2 });
    expect(card.concepts[1].concept).toBe('Legal');
  });

  // Si alguien corrige el nombre en el mes nuevo, la ficha debe mostrar ese,
  // no el viejo, sin partir el histórico.
  it('muestra la grafía más reciente del nombre', () => {
    const [card] = cardsFromLines([
      row({ client: 'vex pro', periodOrder: 24313 }),
      row({ client: 'Vex Pro', periodOrder: 24314, period_id: 'p2', periodLabel: 'Feb 26' }),
    ]);
    expect(card.name).toBe('Vex Pro');
    expect(card.months).toHaveLength(2);
  });

  // La ficha se mira para cobrar: primero el que más debe.
  it('ordena por deuda descendente', () => {
    const cards = cardsFromLines([
      row({ client: 'Sin deuda', amount: 50_000, received: 50_000, pending: 0 }),
      row({ client: 'Debe poco', amount: 1000, received: 0, pending: 1000 }),
      row({ client: 'Debe mucho', amount: 9000, received: 0, pending: 9000 }),
    ]);
    expect(cards.map((c) => c.name)).toEqual(['Debe mucho', 'Debe poco', 'Sin deuda']);
  });

  it('las líneas sin cliente quedan juntas en su propia ficha', () => {
    const cards = cardsFromLines([row({ client: null }), row({ client: '  ' })]);
    expect(cards).toHaveLength(1);
    expect(cards[0].key).toBe(UNASSIGNED_CLIENT_KEY);
  });
});

describe('totalsOf', () => {
  it('cuenta clientes y cuántos deben algo', () => {
    const cards = cardsFromLines([
      row({ client: 'A', amount: 1000, received: 1000, pending: 0 }),
      row({ client: 'B', amount: 2000, received: 500, pending: 1500 }),
      row({ client: 'C', amount: 3000, received: 0, pending: 3000 }),
    ]);
    expect(totalsOf(cards)).toEqual({
      clients: 3, amount: 6000, received: 1500, pending: 4500, withDebt: 2,
    });
  });

  it('sin clientes da todo en cero', () => {
    expect(totalsOf([])).toEqual({ clients: 0, amount: 0, received: 0, pending: 0, withDebt: 0 });
  });
});
