import { describe, it, expect } from 'vitest';
import { parseAmount, computeExpensePending } from './upload-calculations';

// Estos helpers reemplazan la cuenta inline que estaba repetida en cada handler
// de /upload. Los tests fijan la semántica EXACTA del original para que la
// extracción no cambie ni un centavo.

describe('parseAmount', () => {
  it('parsea strings numéricos', () => {
    expect(parseAmount('1234.56')).toBe(1234.56);
    expect(parseAmount('0')).toBe(0);
    expect(parseAmount('-50')).toBe(-50);
  });

  it('vacío / no-numérico / null / undefined → 0 (como `parseFloat(x) || 0`)', () => {
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('abc')).toBe(0);
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount(undefined)).toBe(0);
  });

  it('acepta number directo y descarta NaN/Infinity', () => {
    expect(parseAmount(99.9)).toBe(99.9);
    expect(parseAmount(NaN)).toBe(0);
    expect(parseAmount(Infinity)).toBe(0);
  });

  it('parsea el prefijo numérico igual que parseFloat', () => {
    expect(parseAmount('100abc')).toBe(100);
  });
});

describe('computeExpensePending', () => {
  it('deriva pendiente = amount − paid cuando el campo pendiente está vacío', () => {
    expect(computeExpensePending('1000', '300', '')).toBe(700);
    expect(computeExpensePending('1000', '0', undefined)).toBe(1000);
  });

  it('respeta un pendiente explícito > 0', () => {
    expect(computeExpensePending('1000', '300', '250')).toBe(250);
  });

  it('un pendiente explícito de 0 cae al fallback (igual que `|| amt - pd` original)', () => {
    // Comportamiento heredado: pendiente "0" === vacío → deriva amount - paid.
    expect(computeExpensePending('1000', '300', '0')).toBe(700);
  });

  it('puede dar pendiente negativo si pagado > monto (sin clamp, como el original)', () => {
    expect(computeExpensePending('100', '150', '')).toBe(-50);
  });
});
