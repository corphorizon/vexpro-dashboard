// Filas del listado de órdenes de pago: filtros por estado (iterando el
// registro único TRANSITIONS), conteos, chips, KPIs por moneda y mes UTC,
// recorte del endpoint.
import { describe, expect, it } from 'vitest';
import { TRANSITIONS, type PaymentOrder, type PaymentOrderStatus } from '@/lib/payment-orders/types';
import {
  LIST_LIMIT,
  NO_CHIPS,
  ORDER_STATUSES,
  STATUS_FILTERS,
  applySearchAndChips,
  beneficiaryChips,
  filterOrders,
  isListTruncated,
  orderConcept,
  orderKpis,
  statusCounts,
  sumInCurrency,
  sumOrNull,
} from './orders-view';

let seq = 0;
function order(p: Partial<PaymentOrder> = {}): PaymentOrder {
  seq += 1;
  return {
    id: `o${seq}`,
    order_number: `OP-2026-${String(seq).padStart(4, '0')}`,
    status: 'draft',
    currency: 'USD',
    total: 100,
    issue_date: '2026-10-05',
    created_at: '2026-10-05T12:00:00Z',
    payment_method: 'crypto',
    beneficiary_id: null,
    beneficiary_name: 'Acme',
    lines: [{ description: 'Hosting', unitValue: 100, quantity: 1, amount: 100 }],
    notes: null,
    paid_at: null,
    payment_date: null,
    ...p,
  } as PaymentOrder;
}

describe('STATUS_FILTERS — derivado de la máquina de estados', () => {
  it('tiene «Todas» + un filtro por CADA estado de TRANSITIONS (incluida «rechazada», que faltaba)', () => {
    expect(STATUS_FILTERS[0]).toBe('all');
    for (const s of Object.keys(TRANSITIONS)) expect(STATUS_FILTERS, s).toContain(s);
    expect(STATUS_FILTERS).toContain('rejected');
    expect(STATUS_FILTERS).toHaveLength(Object.keys(TRANSITIONS).length + 1);
  });

  it('filtrar por un estado devuelve sólo ese estado — para cada estado del registro', () => {
    const orders = ORDER_STATUSES.flatMap((s) => [order({ status: s }), order({ status: s })]);
    for (const s of ORDER_STATUSES) {
      const rows = filterOrders(orders, { status: s, query: '', chips: NO_CHIPS });
      expect(rows, s).toHaveLength(2);
      expect(rows.every((o) => o.status === s), s).toBe(true);
    }
    expect(filterOrders(orders, { status: 'all', query: '', chips: NO_CHIPS })).toHaveLength(orders.length);
  });
});

describe('statusCounts', () => {
  it('cuenta por estado y «all» es la suma; un estado sin órdenes es 0 (no falta la clave)', () => {
    const orders = [order({ status: 'pending' }), order({ status: 'pending' }), order({ status: 'paid' })];
    const c = statusCounts(orders);
    expect(c.all).toBe(3);
    expect(c.pending).toBe(2);
    expect(c.paid).toBe(1);
    expect(c.rejected).toBe(0);
    expect(c.cancelled).toBe(0);
    const sumOfStates = ORDER_STATUSES.reduce((s, st) => s + c[st], 0);
    expect(sumOfStates).toBe(c.all);
  });

  it('los conteos respetan búsqueda y chips (no cuentan lo que la tabla esconde)', () => {
    const orders = [
      order({ status: 'pending', beneficiary_name: 'Acme' }),
      order({ status: 'pending', beneficiary_name: 'Globex' }),
      order({ status: 'paid', beneficiary_name: 'Acme', payment_method: 'bank' }),
    ];
    const c = statusCounts(applySearchAndChips(orders, 'acme', NO_CHIPS));
    expect(c).toMatchObject({ all: 2, pending: 1, paid: 1 });
    const bank = statusCounts(applySearchAndChips(orders, '', { methods: ['bank'], beneficiaries: [] }));
    expect(bank).toMatchObject({ all: 1, pending: 0, paid: 1 });
  });

  it('un estado desconocido (dato viejo) cuenta en «all» pero no inventa una clave', () => {
    const c = statusCounts([order({ status: 'weird' as PaymentOrderStatus })]);
    expect(c.all).toBe(1);
    expect(Object.keys(c)).not.toContain('weird');
  });
});

describe('búsqueda y chips', () => {
  it('busca por número, beneficiario y concepto (líneas)', () => {
    const a = order({ beneficiary_name: 'Acme', lines: [{ description: 'Licencias Q3', unitValue: 1, quantity: 1, amount: 1 }] });
    const b = order({ beneficiary_name: 'Globex' });
    expect(filterOrders([a, b], { status: 'all', query: 'licencias', chips: NO_CHIPS })).toEqual([a]);
    expect(filterOrders([a, b], { status: 'all', query: b.order_number.toLowerCase(), chips: NO_CHIPS })).toEqual([b]);
  });

  it('chips: OR dentro de la dimensión, AND entre dimensiones', () => {
    const a = order({ beneficiary_name: 'Acme', payment_method: 'crypto' });
    const b = order({ beneficiary_name: 'Acme', payment_method: 'bank' });
    const c = order({ beneficiary_name: 'Globex', payment_method: 'bank' });
    const both = filterOrders([a, b, c], { status: 'all', query: '', chips: { methods: ['crypto', 'bank'], beneficiaries: [] } });
    expect(both).toHaveLength(3);
    const acmeBank = filterOrders([a, b, c], {
      status: 'all',
      query: '',
      chips: { methods: ['bank'], beneficiaries: ['name:acme'] },
    });
    expect(acmeBank).toEqual([b]);
  });

  it('beneficiaryChips: top N por cantidad y CUENTA los que quedaron afuera', () => {
    const orders = [
      ...['A', 'A', 'A', 'B', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => order({ beneficiary_name: n })),
    ];
    const { chips, hidden } = beneficiaryChips(orders, 3);
    expect(chips.map((c) => [c.label, c.count])).toEqual([
      ['A', 3],
      ['B', 2],
      ['C', 1],
    ]);
    expect(hidden).toBe(4); // D, E, F, G — el recorte se dice, no se calla
  });

  it('el concepto sale de las líneas; sin líneas, de las notas; sin nada, null', () => {
    expect(orderConcept(order())).toBe('Hosting');
    expect(orderConcept(order({ lines: [], notes: '  Adelanto  ' }))).toBe('Adelanto');
    expect(orderConcept(order({ lines: [], notes: null }))).toBeNull();
  });

  it('orden: emisión más reciente primero', () => {
    const old = order({ issue_date: '2026-09-01' });
    const recent = order({ issue_date: '2026-10-09' });
    expect(filterOrders([old, recent], { status: 'all', query: '', chips: NO_CHIPS })).toEqual([recent, old]);
  });
});

describe('KPIs', () => {
  const NOW = new Date('2026-10-12T15:00:00Z');

  it('pendientes / aprobadas suman su total; pagadas del mes y total del mes miran el mes', () => {
    const k = orderKpis(
      [
        order({ status: 'pending', total: 100 }),
        order({ status: 'pending', total: 50.5 }),
        order({ status: 'approved', total: 200 }),
        order({ status: 'paid', total: 300, paid_at: '2026-10-03T10:00:00Z' }),
        order({ status: 'paid', total: 999, paid_at: '2026-09-30T10:00:00Z', issue_date: '2026-09-20' }),
        order({ status: 'draft', total: 1000 }),
        order({ status: 'rejected', total: 1000 }),
        order({ status: 'cancelled', total: 1000 }),
      ],
      NOW,
      'USD',
    );
    expect(k.pending).toEqual({ count: 2, sum: 150.5, otherCurrency: 0 });
    expect(k.approved.sum).toBe(200);
    expect(k.paidMonth).toEqual({ count: 1, sum: 300, otherCurrency: 0 });
    // Emitidas en octubre que comprometen plata: 2 pendientes + aprobada + pagada.
    expect(k.monthTotal).toEqual({ count: 4, sum: 650.5, otherCurrency: 0 });
    // Borrador, rechazada y anulada no se suman, pero se cuentan.
    expect(k.monthExcluded).toBe(3);
  });

  it('el mes es UTC: una OP pagada el 31/10 22:00 en Buenos Aires (01/11 01:00 UTC) es de noviembre', () => {
    const paidLate = order({ status: 'paid', total: 10, paid_at: '2026-11-01T01:00:00Z' });
    expect(orderKpis([paidLate], new Date('2026-10-31T23:30:00Z'), 'USD').paidMonth.count).toBe(0);
    expect(orderKpis([paidLate], new Date('2026-11-01T02:00:00Z'), 'USD').paidMonth.count).toBe(1);
  });

  it('USDT suma como USD; otra moneda NO se suma y se cuenta', () => {
    const s = sumInCurrency(
      [order({ currency: 'USDT', total: 10 }), order({ currency: 'usd', total: 5 }), order({ currency: 'ARS', total: 500000 })],
      'USD',
    );
    expect(s).toEqual({ count: 3, sum: 15, otherCurrency: 1 });
  });

  it('sumOrNull: todo en otra moneda es «sin dato» (null), nunca $0; vacío sí es 0', () => {
    expect(sumOrNull({ count: 2, sum: 0, otherCurrency: 2 })).toBeNull();
    expect(sumOrNull({ count: 0, sum: 0, otherCurrency: 0 })).toBe(0);
    expect(sumOrNull({ count: 3, sum: 15, otherCurrency: 1 })).toBe(15);
  });
});

describe('isListTruncated — el endpoint corta sin avisar', () => {
  it('lista llena = puede haber más; menos que el pedido = está todo', () => {
    expect(isListTruncated(LIST_LIMIT)).toBe(true);
    expect(isListTruncated(LIST_LIMIT - 1)).toBe(false);
    expect(isListTruncated(0)).toBe(false);
    expect(isListTruncated(200, 200)).toBe(true);
  });
});
