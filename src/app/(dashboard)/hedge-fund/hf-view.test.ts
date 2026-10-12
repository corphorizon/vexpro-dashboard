import { describe, expect, it } from 'vitest';
import { capitalRows, daysLeftTone, hfStatusKind, singleCurrency, sumKnown, HF_SOON_DAYS } from './hf-view';

describe('singleCurrency', () => {
  it('una sola moneda (sin moneda = USD)', () => {
    expect(singleCurrency([{ currency: 'USD' }, { currency: null }])).toBe('USD');
    expect(singleCurrency([{ currency: 'EUR' }])).toBe('EUR');
  });
  it('monedas mezcladas → null: no hay total', () => {
    expect(singleCurrency([{ currency: 'USD' }, { currency: 'EUR' }])).toBeNull();
  });
  it('sin filas, USD (la tabla vacía no muestra total igual)', () => {
    expect(singleCurrency([])).toBe('USD');
  });
});

describe('daysLeftTone', () => {
  it('vencida y abierta → neg', () => {
    expect(daysLeftTone(-1)).toBe('neg');
    expect(daysLeftTone(-400)).toBe('neg');
  });
  it('vence dentro de 30 días (inclusive, hoy incluido) → pend', () => {
    expect(daysLeftTone(0)).toBe('pend');
    expect(daysLeftTone(HF_SOON_DAYS)).toBe('pend');
  });
  it('más de 30 días → sin color', () => {
    expect(daysLeftTone(HF_SOON_DAYS + 1)).toBeNull();
  });
  it('sin fecha de fin NO es «vence hoy»', () => {
    expect(daysLeftTone(null)).toBeNull();
    expect(daysLeftTone(undefined)).toBeNull();
    expect(daysLeftTone(Number.NaN)).toBeNull();
  });
});

describe('hfStatusKind', () => {
  it('OPEN / ACTIVE = ok, sin importar mayúsculas', () => {
    expect(hfStatusKind('OPEN')).toBe('ok');
    expect(hfStatusKind('active')).toBe('ok');
  });
  it('lo que no conocemos va neutro (no se inventa un color)', () => {
    expect(hfStatusKind('CLOSED')).toBe('neutral');
    expect(hfStatusKind('TERMINATED')).toBe('neutral');
    expect(hfStatusKind('WHATEVER')).toBe('neutral');
    expect(hfStatusKind(null)).toBe('neutral');
    expect(hfStatusKind('')).toBe('neutral');
  });
});

describe('capitalRows', () => {
  it('une solicitudes y TERMINATION, más reciente primero, sin fecha al final', () => {
    const rows = capitalRows({
      requests: [
        { requestId: 'r1', fundKey: 'a', status: 'PENDING', amount: 10, currency: 'USD', at: '2026-09-01' },
        { requestId: 'r2', fundKey: 'a', status: 'PENDING', amount: 5, currency: 'USD', at: null },
      ],
      terminations: [{ entryId: 't1', fundKey: 'b', amount: 20, currency: 'USD', at: '2026-10-01' }],
    });
    expect(rows.map((r) => r.id)).toEqual(['t1', 'r1', 'r2']);
    expect(rows[0]).toMatchObject({ kind: 'termination', status: 'TERMINATION' });
  });
  it('vacío es vacío', () => {
    expect(capitalRows({ requests: [], terminations: [] })).toEqual([]);
  });
});

describe('sumKnown', () => {
  it('suma lo conocido', () => {
    expect(sumKnown([10, null, 5.555])).toBe(15.56);
  });
  it('nada conocido → null, no 0', () => {
    expect(sumKnown([null, undefined])).toBeNull();
    expect(sumKnown([])).toBeNull();
  });
});
