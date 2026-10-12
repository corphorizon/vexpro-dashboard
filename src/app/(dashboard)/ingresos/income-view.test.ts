// /ingresos: estado de la línea (con «Parcial»), búsqueda/orden y facturación
// por cliente con la MISMA función que el PDF de cierre.
import { describe, it, expect } from 'vitest';
import type { IncomeLine } from '@/lib/income-lines';
import { computeIncomeTotals } from '@/lib/income-lines';
import { UNASSIGNED_CLIENT_KEY, cardsFromLines } from '@/lib/clients';
import { buildBilling } from '@/lib/reports/company-report';
import {
  INCOME_STATUS_KIND,
  billingByClient,
  filterIncomeLines,
  incomeLineStatus,
  type IncomeLineStatus,
} from './income-view';

let seq = 0;
function line(p: Partial<IncomeLine>): IncomeLine {
  seq += 1;
  return {
    id: `l${seq}`,
    company_id: 'c1',
    period_id: 'sep',
    concept: `Factura ${seq}`,
    client: null,
    amount: 100,
    received: 100,
    pending: 0,
    category: null,
    reference: null,
    income_date: null,
    sort_order: seq,
    created_at: '2026-09-01',
    updated_at: '2026-09-01',
    ...p,
  };
}

const PERIODS = [
  { id: 'ago', year: 2026, month: 8, label: 'Ago 26' },
  { id: 'sep', year: 2026, month: 9, label: 'Sep 26' },
];

const LINES: IncomeLine[] = [
  line({ id: '1', concept: 'Asesoría', client: 'Vex Pro', amount: 1000, received: 1000, pending: 0 }),
  line({ id: '2', concept: 'Auditoría', client: 'vex pro ', amount: 500, received: 200, pending: 300, reference: 'FAC-0012' }),
  line({ id: '3', concept: 'Soporte', client: 'Horizon', amount: 800, received: 0, pending: 800, period_id: 'ago' }),
  line({ id: '4', concept: 'Varios', client: null, amount: 50, received: 50, pending: 0 }),
];

describe('estado de una línea de ingreso', () => {
  it('cobrada / parcial / por cobrar', () => {
    expect(incomeLineStatus(LINES[0])).toBe('collected');
    expect(incomeLineStatus(LINES[1])).toBe('partial');
    expect(incomeLineStatus(LINES[2])).toBe('pending');
  });

  it('un pendiente de menos de un centavo es redondeo, no deuda', () => {
    expect(incomeLineStatus({ received: 99.995, pending: 0.005 })).toBe('collected');
    expect(incomeLineStatus({ received: 0, pending: 0.01 })).toBe('pending');
  });

  it('una línea de $0 sin cobrar no se debe: cobrada (como antes de la migración)', () => {
    expect(incomeLineStatus({ received: 0, pending: 0 })).toBe('collected');
  });

  it('sólo «cobrada» es ok: parcial y por cobrar piden acción', () => {
    const kinds = (Object.keys(INCOME_STATUS_KIND) as IncomeLineStatus[]).map((s) => [s, INCOME_STATUS_KIND[s]]);
    expect(kinds).toEqual([
      ['collected', 'ok'],
      ['partial', 'pend'],
      ['pending', 'pend'],
    ]);
  });
});

describe('búsqueda y orden', () => {
  it('busca en concepto, cliente y referencia, sin distinguir mayúsculas', () => {
    expect(filterIncomeLines(LINES, 'HORIZON', 'default').map((l) => l.id)).toEqual(['3']);
    expect(filterIncomeLines(LINES, 'fac-0012', 'default').map((l) => l.id)).toEqual(['2']);
  });

  it('sin coincidencias devuelve vacío; sin búsqueda conserva el orden de carga', () => {
    expect(filterIncomeLines(LINES, 'nada', 'default')).toEqual([]);
    expect(filterIncomeLines(LINES, '  ', 'default').map((l) => l.id)).toEqual(['1', '2', '3', '4']);
  });

  it('orden por monto asc/desc sin mutar la entrada', () => {
    const before = LINES.map((l) => l.id);
    expect(filterIncomeLines(LINES, '', 'desc').map((l) => l.amount)).toEqual([1000, 800, 500, 50]);
    expect(filterIncomeLines(LINES, '', 'asc').map((l) => l.amount)).toEqual([50, 500, 800, 1000]);
    expect(LINES.map((l) => l.id)).toEqual(before);
  });
});

describe('facturación por cliente — la del PDF de cierre', () => {
  it('es buildBilling(cardsFromLines(...)) sin fórmula propia', () => {
    const b = billingByClient(LINES, PERIODS);
    const ref = buildBilling(
      cardsFromLines(
        LINES.map((l) => {
          const p = PERIODS.find((x) => x.id === l.period_id)!;
          return { ...l, periodLabel: p.label, periodOrder: p.year * 12 + p.month };
        }),
      ),
    );
    expect(b).toEqual(ref);
  });

  it('agrupa «Vex Pro» y «vex pro », quien más debe primero, y el sin cliente aparte', () => {
    const b = billingByClient(LINES, PERIODS);
    expect(b.clients.map((c) => [c.name, c.billed, c.collected, c.pending])).toEqual([
      ['Horizon', 800, 0, 800],
      ['vex pro', 1500, 1200, 300],
      ['', 50, 50, 0],
    ]);
    expect(b.clients[2].key).toBe(UNASSIGNED_CLIENT_KEY);
    expect(b.clientCount).toBe(3);
    expect(b.withDebt).toBe(2);
  });

  it('los totales por cliente cuadran con los de las líneas (la tabla de abajo)', () => {
    const b = billingByClient(LINES, PERIODS);
    const t = computeIncomeTotals(LINES);
    expect([b.billed, b.collected, b.pending]).toEqual([t.amount, t.received, t.pending]);
  });

  it('una línea de un período desconocido NO se descarta (el total seguiría cuadrando)', () => {
    const b = billingByClient([line({ period_id: 'otro', client: 'X', amount: 10, received: 0, pending: 10 })], PERIODS);
    expect(b.billed).toBe(10);
    expect(b.pending).toBe(10);
  });

  it('sin líneas: sin clientes y totales en cero', () => {
    expect(billingByClient([], PERIODS)).toMatchObject({ billed: 0, collected: 0, pending: 0, clientCount: 0, clients: [] });
  });
});
