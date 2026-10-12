// El filtro de /clientes y el conteo de sus chips («Libro mayor», 2026-10-12):
// una sola regla de «debe», la misma que usa `totalsOf` para el KPI.
import { describe, it, expect } from 'vitest';
import { UNASSIGNED_CLIENT_KEY, totalsOf, type ClientCard } from '@/lib/clients';
import { DEBT_EPSILON, clientDisplayName, filterClients, filterCounts, owes } from './clients-view';

const card = (key: string, name: string, pending: number): ClientCard => ({
  key,
  name,
  amount: pending + 100,
  received: 100,
  pending,
  months: [],
  concepts: [],
  firstPeriodLabel: 'Ago 2026',
  lastPeriodLabel: 'Sep 2026',
});

const CARDS = [
  card('acme', 'ACME', 1200),
  card('globex', 'Globex', 0),
  card('initech', 'Initech', 0.004), // redondeo: no debe
  card(UNASSIGNED_CLIENT_KEY, '', 50),
];

describe('owes', () => {
  it('por debajo del centavo no es deuda', () => {
    expect(owes({ pending: DEBT_EPSILON })).toBe(false);
    expect(owes({ pending: 0.01 })).toBe(true);
    expect(owes({ pending: 0 })).toBe(false);
  });
});

describe('filterClients', () => {
  const base = { query: '', unassignedLabel: 'Sin cliente asignado' };

  it('todos: no recorta nada', () => {
    expect(filterClients(CARDS, { ...base, filter: 'all' })).toHaveLength(4);
  });

  it('con deuda: sólo los que deben más de un centavo', () => {
    expect(filterClients(CARDS, { ...base, filter: 'debt' }).map((c) => c.key)).toEqual([
      'acme',
      UNASSIGNED_CLIENT_KEY,
    ]);
  });

  it('la ficha sin cliente se busca por su etiqueta, no por la clave cruda', () => {
    expect(filterClients(CARDS, { ...base, filter: 'all', query: 'sin cliente' }).map((c) => c.key)).toEqual([
      UNASSIGNED_CLIENT_KEY,
    ]);
    expect(filterClients(CARDS, { ...base, filter: 'all', query: '__unassigned' })).toHaveLength(0);
  });

  it('búsqueda sin mayúsculas ni espacios de más, combinada con el filtro', () => {
    expect(filterClients(CARDS, { ...base, filter: 'debt', query: '  acm ' }).map((c) => c.key)).toEqual(['acme']);
    expect(filterClients(CARDS, { ...base, filter: 'debt', query: 'globex' })).toHaveLength(0);
  });
});

describe('filterCounts', () => {
  it('el chip «Con deuda» cuenta lo mismo que el KPI de totalsOf', () => {
    const counts = filterCounts(CARDS);
    expect(counts).toEqual({ all: 4, debt: 2 });
    expect(counts.debt).toBe(totalsOf(CARDS).withDebt);
  });
});

describe('clientDisplayName', () => {
  it('rotula la ficha sin cliente', () => {
    expect(clientDisplayName(CARDS[3], 'Sin cliente')).toBe('Sin cliente');
    expect(clientDisplayName(CARDS[0], 'Sin cliente')).toBe('ACME');
  });
});
