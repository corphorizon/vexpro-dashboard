import { describe, it, expect } from 'vitest';
import { formatMoney, MONEY_LOCALE, MINUS_SIGN, round2 } from './money';
import { formatCurrency, round2 as round2FromUtils } from './utils';
import { pdfMoney } from './monthly-close-pdf-data';

describe('formatMoney', () => {
  it('el locale por defecto sigue siendo en-US (el dueño no decidió todavía)', () => {
    expect(MONEY_LOCALE).toBe('en-US');
  });

  it('positivo', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50');
    expect(formatMoney(45_205)).toBe('$45,205.00');
  });

  it('negativo: el signo va ANTES del símbolo, nunca «$-»', () => {
    expect(formatMoney(-1234.5)).toBe('-$1,234.50');
    expect(formatMoney(-208_084.45)).not.toContain('$-');
  });

  it('cero, -0 y lo que redondea a cero es «$0.00», nunca «-$0.00»', () => {
    expect(formatMoney(0)).toBe('$0.00');
    expect(formatMoney(-0)).toBe('$0.00');
    expect(formatMoney(-0.001)).toBe('$0.00');
    expect(formatMoney(0, { signed: true })).toBe('$0.00');
  });

  it('signed: «+» en positivos y «−» tipográfico (U+2212) en negativos', () => {
    expect(formatMoney(1234.5, { signed: true })).toBe('+$1,234.50');
    expect(formatMoney(-12, { signed: true })).toBe(`${MINUS_SIGN}$12.00`);
    expect(MINUS_SIGN).toBe('−');
    // Sin `signed` el menos es el guion ASCII: jsPDF/Helvetica no tiene U+2212.
    expect(formatMoney(-12)).not.toContain(MINUS_SIGN);
  });

  it('compact', () => {
    expect(formatMoney(45_205, { compact: true })).toBe('$45.2K');
    expect(formatMoney(1_304_598.25, { compact: true })).toBe('$1.3M');
    expect(formatMoney(-45_205, { compact: true })).toBe('-$45.2K');
    expect(formatMoney(950, { compact: true })).toBe('$950');
  });

  it("con MONEY_LOCALE = 'es-AR' da «$45.205,00» (cambiar el formato es una línea)", () => {
    expect(formatMoney(45_205, { locale: 'es-AR' })).toBe('$45.205,00');
    expect(formatMoney(-45_205, { locale: 'es-AR' })).toBe('-$45.205,00');
    // Sin «US$» ni espacio: el símbolo no depende del locale.
    expect(formatMoney(45_205, { locale: 'es-AR' })).not.toContain('US');
  });

  it('otras monedas: el símbolo de en-US delante', () => {
    expect(formatMoney(10, { currency: 'EUR' })).toBe('€10.00');
    expect(formatMoney(-10, { currency: 'EUR' })).toBe('-€10.00');
    expect(formatMoney(10, { currency: 'COP' })).toBe('COP 10.00');
  });

  it('NaN / Infinity no se disfrazan de número', () => {
    expect(formatMoney(Number.NaN)).toBe('—');
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('redondea a centavos antes de formatear (round2)', () => {
    expect(formatMoney(1.005)).toBe(`$${round2(1.005).toFixed(2)}`);
    expect(formatMoney(0.1 + 0.2)).toBe('$0.30');
  });
});

describe('los formateadores viejos delegan en formatMoney', () => {
  const casos = [0, -0.001, 1234.5, -1234.5, 226_605.2, -208_084.45, 1e9];

  it('formatCurrency (USD) da exactamente lo mismo', () => {
    for (const n of casos) expect(formatCurrency(n)).toBe(formatMoney(n));
  });

  it('formatCurrency respeta la moneda', () => {
    expect(formatCurrency(10, 'EUR')).toBe(formatMoney(10, { currency: 'EUR' }));
  });

  it('pdfMoney da exactamente lo mismo', () => {
    for (const n of casos) expect(pdfMoney(n)).toBe(formatMoney(n));
  });

  it('round2 de utils es el de money (una sola copia)', () => {
    expect(round2FromUtils).toBe(round2);
  });
});
