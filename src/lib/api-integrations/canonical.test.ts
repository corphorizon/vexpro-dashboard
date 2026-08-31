import { describe, it, expect } from 'vitest';
import { canonicalAmount, canonicalFee } from './canonical';

// These functions handle MONEY, so the tests are the safety net before
// changing any provider integration. The fixtures below mirror real
// transaction shapes seen in /api/integrations/movements responses.

describe('canonicalAmount', () => {
  it('picks amountTarget for Coinsbuy deposits', () => {
    const tx = { id: 'cb-d-1', amountTarget: 1234.56, amountSource: 999, createdAt: '2026-01-01T00:00:00Z' };
    expect(canonicalAmount(tx as never)).toBe(1234.56);
  });

  it('picks chargedAmount for Coinsbuy withdrawals', () => {
    const tx = { id: 'cb-w-1', chargedAmount: 500.5, createdAt: '2026-01-01T00:00:00Z' };
    expect(canonicalAmount(tx as never)).toBe(500.5);
  });

  it('picks net for FairPay transactions', () => {
    const tx = { id: 'fp-1', net: 800, billed: 850, createdAt: '2026-01-01T00:00:00Z' };
    expect(canonicalAmount(tx as never)).toBe(800);
  });

  it('picks netAmount for UniPayment transactions', () => {
    const tx = { id: 'up-1', netAmount: 920, grossAmount: 1000, createdAt: '2026-01-01T00:00:00Z' };
    expect(canonicalAmount(tx as never)).toBe(920);
  });

  it('picks amount for Pay-Pros (resuelto por provider, no por campo)', () => {
    const tx = { id: 'crm:abc', provider: 'paypros', amount: 500, createdAt: '2026-08-30T21:26:50Z' };
    expect(canonicalAmount(tx as never)).toBe(500);
  });

  it('Pay-Pros gana sobre cualquier otro campo homónimo', () => {
    // Un retiro de Coinsbuy también tiene `amount` (el solicitado) y el que
    // cuenta es `chargedAmount`. Por eso Pay-Pros se decide por `provider`:
    // un `'amount' in tx` genérico elegiría mal para Coinsbuy.
    const cbWithdrawal = { id: 'w', provider: 'coinsbuy', amount: 100, chargedAmount: 103 };
    expect(canonicalAmount(cbWithdrawal as never)).toBe(103);
  });

  it('returns 0 when no canonical field is present', () => {
    const tx = { id: 'unknown', createdAt: '2026-01-01T00:00:00Z' };
    expect(canonicalAmount(tx as never)).toBe(0);
  });

  it('returns 0 when the canonical field is null', () => {
    const tx = { id: 'cb-d-2', amountTarget: null, createdAt: '2026-01-01T00:00:00Z' };
    expect(canonicalAmount(tx as never)).toBe(0);
  });

  it('disambiguates by FIRST matching field even when others are present', () => {
    // Defensive: if a future tx ever carried both amountTarget and net
    // (shouldn't happen given the type system, but the function is
    // type-erased at runtime), the deterministic order matters for
    // reconciliation.
    const tx = { id: 'mix', amountTarget: 10, net: 99, createdAt: '2026-01-01T00:00:00Z' };
    expect(canonicalAmount(tx as never)).toBe(10);
  });
});

describe('canonicalFee', () => {
  it('picks commission first', () => {
    const tx = { id: 'fp-1', commission: 5, fee: 99, createdAt: '2026-01-01T00:00:00Z' };
    expect(canonicalFee(tx as never)).toBe(5);
  });

  it('falls back to mdr when commission is absent', () => {
    const tx = { id: 'fp-2', mdr: 3.25, createdAt: '2026-01-01T00:00:00Z' };
    expect(canonicalFee(tx as never)).toBe(3.25);
  });

  it('falls back to fee for Coinsbuy', () => {
    const tx = { id: 'cb-1', fee: 1.5, createdAt: '2026-01-01T00:00:00Z' };
    expect(canonicalFee(tx as never)).toBe(1.5);
  });

  it('Pay-Pros no informa comisión: 0 explícito', () => {
    const tx = { id: 'crm:abc', provider: 'paypros', amount: 500, commission: 9 };
    // Aunque una fila trajera `commission` de alguna variante futura, el
    // proveedor no cobra comisión informada y así se persiste desde el día 1.
    expect(canonicalFee(tx as never)).toBe(0);
  });

  it('returns 0 when no fee field is present (UniPayment after Excel backfill)', () => {
    // UniPayment doesn't expose per-invoice fees through its API; the
    // Excel-sourced fees live in the `fee` column directly, not in the
    // raw tx — so canonicalFee returns 0 and persistence reads from the
    // backfill marker instead.
    const tx = { id: 'up-1', createdAt: '2026-01-01T00:00:00Z' };
    expect(canonicalFee(tx as never)).toBe(0);
  });
});
