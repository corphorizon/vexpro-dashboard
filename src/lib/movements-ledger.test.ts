import { describe, expect, it } from 'vitest';
import { computeProviderTotals, countPayprosPayouts } from '@/lib/api-integrations/totals';
import { statusKind } from '@/components/ui/status-kind';
import type { ProviderDataset, ProviderSlug, ProviderTransaction } from '@/lib/api-integrations/types';
import {
  countedNet,
  dailyNet,
  dayKey,
  filterLedger,
  ledgerCounts,
  ledgerRows,
  matchesLedgerQuery,
  pendingFromDatasets,
  signedAmount,
  toLedgerRow,
} from './movements-ledger';

// Fechas locales (sin Z): dayKey agrupa por día LOCAL, igual que formatDateTime.
const ds = (slug: ProviderSlug, transactions: unknown[]): ProviderDataset => ({
  slug,
  provider: slug.startsWith('coinsbuy') ? 'coinsbuy' : (slug as 'fairpay'),
  kind: slug === 'coinsbuy-withdrawals' ? 'withdrawals' : 'deposits',
  transactions: transactions as ProviderTransaction[],
  fetchedAt: '2026-10-12T10:00:00',
  status: 'fresh',
  isMock: false,
});

const cbDeposits = ds('coinsbuy-deposits', [
  { id: 'd1', createdAt: '2026-10-10T09:00:00', label: 'Ana', trackingId: 'T1', commission: 1, amountTarget: 100, status: 'Confirmed' },
  { id: 'd2', createdAt: '2026-10-10T15:30:00', label: 'Beto', trackingId: 'T2', commission: 2, amountTarget: 250.5, status: 'Confirmed' },
  { id: 'd3', createdAt: '2026-10-11T08:00:00', label: 'Caro', trackingId: 'T3', commission: 0, amountTarget: 40, status: 'Pending' },
  { id: 'd4', createdAt: '2026-10-11T09:00:00', label: 'Dani', trackingId: 'T4', commission: 0, amountTarget: 70, status: 'Failed' },
  { id: 'd5', createdAt: '2026-10-11T10:00:00', label: 'Eva', trackingId: 'T5', commission: 3, amountTarget: 500, status: 'Confirmed', excluded: true, excludedReason: 'fondeo' },
]);

const cbWithdrawals = ds('coinsbuy-withdrawals', [
  { id: 'w1', createdAt: '2026-10-10T11:00:00', label: 'Ana', trackingId: 'X1', amount: 90, chargedAmount: 91, commission: 1, status: 'Approved' },
  { id: 'w2', createdAt: '2026-10-10T12:00:00', label: 'Int', trackingId: 'X2', amount: 300, chargedAmount: 300, commission: 0, status: 'Approved', internal: true },
  { id: 'w3', createdAt: '2026-10-11T12:00:00', label: 'Beto', trackingId: 'X3', amount: 20, chargedAmount: 21, commission: 1, status: 'Rejected' },
]);

const fairpay = ds('fairpay', [
  { id: 'f1', createdAt: '2026-10-10T10:00:00', customerEmail: 'a@x.com', billed: 110, mdr: 10, net: 100, status: 'Completed' },
  { id: 'f2', createdAt: '2026-10-10T11:00:00', customerEmail: 'b@x.com', billed: 55, mdr: 5, net: 50, status: 'Pending' },
]);

const unipayment = ds('unipayment', [
  { id: 'u1', createdAt: '2026-10-10T10:00:00', email: 'c@x.com', orderId: 'O1', grossAmount: 21, fee: 1, netAmount: 20, status: 'Completed' },
  { id: 'u2', createdAt: '2026-10-10T11:00:00', email: 'd@x.com', orderId: 'O2', grossAmount: 9, fee: 1, netAmount: 8, status: 'Expired' },
]);

const paypros = ds('paypros', [
  { id: 'p1', createdAt: '2026-10-10T10:00:00', amount: 200, status: 'paid', kind: 'deposit', notifyReference: 'N1' },
  { id: 'p2', createdAt: '2026-10-10T18:00:00', amount: 75, status: 'payout_paid', kind: 'withdrawal', notifyReference: 'N2' },
  { id: 'p3', createdAt: '2026-10-11T10:00:00', amount: 30, status: 'unpaid', kind: 'deposit', notifyReference: 'N3' },
  { id: 'p4', createdAt: '2026-10-11T11:00:00', amount: 15, status: 'payout_declined', kind: 'deposit', notifyReference: 'N4' },
]);

const ALL = [cbDeposits, cbWithdrawals, fairpay, unipayment, paypros];

const sumCounted = (d: ProviderDataset, direction: 'deposit' | 'withdrawal') =>
  Math.round(
    ledgerRows(d)
      .filter((r) => r.counts && r.direction === direction)
      .reduce((s, r) => s + r.amount, 0) * 100,
  ) / 100;

describe('movements-ledger — la fila «cuenta» con el MISMO criterio que el total canónico', () => {
  it.each(ALL.map((d) => [d.slug, d] as const))('%s: Σ filas que cuentan === computeProviderTotals', (_slug, d) => {
    const direction = d.slug === 'coinsbuy-withdrawals' ? 'withdrawal' : 'deposit';
    const totals = computeProviderTotals(d);
    expect(sumCounted(d, direction)).toBe(Math.round(totals.total * 100) / 100);
    expect(ledgerRows(d).filter((r) => r.counts && r.direction === direction)).toHaveLength(totals.count);
  });

  it('Pay-Pros: los payout_paid cuentan como RETIRO y suman lo que countPayprosPayouts', () => {
    expect(sumCounted(paypros, 'withdrawal')).toBe(countPayprosPayouts(paypros).total);
    const declined = toLedgerRow('paypros', paypros.transactions[3]);
    expect(declined.direction).toBe('withdrawal'); // un payout rechazado no es un depósito
    expect(declined.counts).toBe(false);
    expect(declined.category).toBe('rejected');
  });

  it('Pay-Pros no informa comisión: fee null, no 0', () => {
    expect(ledgerRows(paypros).every((r) => r.fee === null)).toBe(true);
  });
});

describe('categorías', () => {
  it('excluida > interna > cuenta > pendiente > rechazada > otra', () => {
    const cats = Object.fromEntries(ledgerRows(cbDeposits).map((r) => [r.id, r.category]));
    expect(cats).toEqual({ d1: 'counts', d2: 'counts', d3: 'pending', d4: 'rejected', d5: 'excluded' });
    const w = Object.fromEntries(ledgerRows(cbWithdrawals).map((r) => [r.id, r.category]));
    expect(w).toEqual({ w1: 'counts', w2: 'internal', w3: 'rejected' });
    expect(toLedgerRow('unipayment', unipayment.transactions[1]).category).toBe('other'); // Expired
  });

  it('statusKind apiTx: verde sólo lo cobrado, Pending pend, Failed/Rejected bad', () => {
    expect(statusKind('apiTx', 'Confirmed')).toBe('ok');
    expect(statusKind('apiTx', 'Approved')).toBe('ok');
    expect(statusKind('apiTx', 'Completed')).toBe('ok');
    expect(statusKind('apiTx', 'Pending')).toBe('pend');
    expect(statusKind('apiTx', 'Rejected')).toBe('bad');
    expect(statusKind('apiTx', 'Failed')).toBe('bad');
    expect(statusKind('apiTx', 'Expired')).toBe('neutral');
    expect(statusKind('apiTx', 'algo-nuevo')).toBe('neutral');
  });

  it('ledgerCounts cuenta por sentido y categoría', () => {
    const c = ledgerCounts(ledgerRows(paypros));
    expect(c).toMatchObject({ all: 4, deposit: 2, withdrawal: 2 });
    expect(c.byCategory).toMatchObject({ counts: 2, pending: 1, rejected: 1 });
  });
});

describe('agrupación por día con neto diario', () => {
  it('neto = depósitos − retiros de las filas que cuentan, por día local', () => {
    const rows = ledgerRows(paypros);
    expect(dailyNet(rows)).toEqual({ '2026-10-10': 125, '2026-10-11': 0 });
  });

  it('un día sin filas que cuenten da 0 (sabemos que no se movió plata), no desaparece', () => {
    const net = dailyNet(ledgerRows(cbWithdrawals));
    expect(net['2026-10-11']).toBe(0);
    expect(net['2026-10-10']).toBe(-91); // la interna (300) no cuenta
  });

  it('el neto se calcula sobre la lista entera, no sobre la página', () => {
    const rows = ledgerRows(cbDeposits);
    const page1 = rows.slice(0, 2);
    // d5 (excluida) y d4/d3 son del 11; las dos primeras filas (más nuevas) son del 11.
    expect(dailyNet(rows)['2026-10-10']).toBe(350.5);
    expect(dailyNet(page1)['2026-10-10']).toBeUndefined();
  });

  it('countedNet suma con signo y redondea al centavo', () => {
    const rows = [...ledgerRows(cbDeposits), ...ledgerRows(cbWithdrawals)];
    expect(countedNet(rows)).toBe(259.5); // 100 + 250.5 − 91
    expect(countedNet([])).toBe(0);
  });

  it('dayKey: fecha inválida → «sin-fecha», no se pierde la fila', () => {
    expect(dayKey('no-es-fecha')).toBe('sin-fecha');
    expect(dayKey('2026-10-10T23:59:00')).toBe('2026-10-10');
  });

  it('las filas salen de la más nueva a la más vieja', () => {
    const ats = ledgerRows(cbDeposits).map((r) => r.at);
    expect(ats).toEqual([...ats].sort().reverse());
  });

  it('signedAmount: retiro negativo', () => {
    expect(signedAmount({ amount: 10, direction: 'withdrawal' })).toBe(-10);
    expect(signedAmount({ amount: 10, direction: 'deposit' })).toBe(10);
  });
});

describe('filtros y búsqueda', () => {
  const rows = ledgerRows(paypros);
  it('por sentido y por categoría (vacío = todas)', () => {
    expect(filterLedger(rows, { direction: 'withdrawal', categories: [], query: '' }).map((r) => r.id)).toEqual(['p4', 'p2']);
    expect(filterLedger(rows, { direction: 'all', categories: ['counts'], query: '' }).map((r) => r.id)).toEqual(['p2', 'p1']);
  });
  it('búsqueda por id, referencia o monto, sin mayúsculas', () => {
    const r = toLedgerRow('coinsbuy-deposits', cbDeposits.transactions[1]);
    expect(matchesLedgerQuery(r, 'beto')).toBe(true);
    expect(matchesLedgerQuery(r, 't2')).toBe(true);
    expect(matchesLedgerQuery(r, '250.5')).toBe(true);
    expect(matchesLedgerQuery(r, 'zzz')).toBe(false);
    expect(matchesLedgerQuery(r, '   ')).toBe(true);
  });
});

describe('pendingFromDatasets — KPI «Pendientes»', () => {
  it('cuenta lo pendiente (no excluido) de todos los proveedores', () => {
    const p = pendingFromDatasets(ALL)!;
    expect(p.count).toBe(3); // d3 (Coinsbuy), f2 (FairPay), p3 (Pay-Pros unpaid)
    expect(p.amount).toBe(120);
    expect(p.channels.sort()).toEqual(['Coinsbuy', 'FairPay', 'Pay-Pros']);
  });
  it('sin datasets: null («no lo sabemos»), nunca {0,0}', () => {
    expect(pendingFromDatasets([])).toBeNull();
  });
});
