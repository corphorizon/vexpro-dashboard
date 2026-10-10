// ─────────────────────────────────────────────────────────────────────────────
// Wallet de arranque del selector de /movimientos — lo que protege este test es
// que la tarjeta «Coinsbuy · Depósitos» no abra en $0 por una wallet interna.
//
// AP Markets, 2026-10-05: al fijar wallets desde el selector, la 1804 "Expenses
// AP Markets" (rol interno, solo retiros de gastos) quedó persistida como
// default. Octubre real: 21 depósitos por $16.305,27 en la 1362 "AP MARKETS".
// La tarjeta decía $0,00 · 0 tx · Confirmed.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { resolveStartupWallet, nextDefaultAfterInternal, PINNED_WALLET_ROLES } from './pinned-wallet-roles';

// Pins reales de AP Markets (orden = created_at, como las devuelve la consulta).
const AP_PINS = [
  { wallet_id: '1553', wallet_label: 'AP Markets CMA', role: 'operating' },
  { wallet_id: '1801', wallet_label: 'AP Instant Payouts', role: 'operating' },
  { wallet_id: '1804', wallet_label: 'Expenses AP Markets', role: 'internal' },
  { wallet_id: '1362', wallet_label: 'AP MARKETS', role: 'operating' },
];

describe('resolveStartupWallet', () => {
  it('una default INTERNA arranca en la primera operativa (el bug de AP Markets)', () => {
    expect(resolveStartupWallet('1804', AP_PINS)).toBe('1553');
  });

  it('una default operativa se respeta tal cual', () => {
    expect(resolveStartupWallet('1362', AP_PINS)).toBe('1362');
  });

  it('sin pins cargadas no se adivina: se respeta la preferida', () => {
    expect(resolveStartupWallet('1804', [])).toBe('1804');
  });

  it('una preferida que no está fijada se respeta (puede ser legítima aunque no esté pineada)', () => {
    expect(resolveStartupWallet('9999', AP_PINS)).toBe('9999');
  });

  it('sin preferida y con operativas, arranca en la primera operativa', () => {
    expect(resolveStartupWallet('', AP_PINS)).toBe('1553');
  });

  it('sin preferida y sin operativas (solo internas) devuelve la preferida vacía: nunca inventa una interna', () => {
    expect(resolveStartupWallet('', [{ wallet_id: '1804', role: 'internal' }])).toBe('');
  });

  it('preferida interna y SOLO internas fijadas: se respeta la preferida (no hay nada mejor, y "" iría a una wallet a ciegas)', () => {
    expect(resolveStartupWallet('1804', [{ wallet_id: '1804', role: 'internal' }, { wallet_id: '1087', role: 'internal' }])).toBe('1804');
  });

  it('cubre todos los roles del registro (§5.8): operativa se queda, interna se reemplaza', () => {
    for (const role of PINNED_WALLET_ROLES) {
      const pins = [{ wallet_id: 'X', role }, { wallet_id: 'OP', role: 'operating' }];
      expect(resolveStartupWallet('X', pins)).toBe(role === 'internal' ? 'OP' : 'X');
    }
  });

  it('las filas sin rol (pre-migración 084) cuentan como operativas', () => {
    expect(resolveStartupWallet('1804', [{ wallet_id: '1804', role: 'internal' }, { wallet_id: '1079' }])).toBe('1079');
  });
});

describe('nextDefaultAfterInternal', () => {
  it('la wallet que pasó a interna cede el default a la primera operativa fijada', () => {
    expect(nextDefaultAfterInternal('1804', AP_PINS)).toBe('1553');
  });

  it('sin operativas fijadas el default queda en null: no se persiste una interna ni se inventa', () => {
    expect(nextDefaultAfterInternal('1804', [{ wallet_id: '1804', role: 'internal' }])).toBeNull();
  });

  it('si la wallet ya no está fijada (pestaña vieja) el default queda en null: sin pin no hay rol conocido', () => {
    expect(nextDefaultAfterInternal('1804', [])).toBeNull();
  });
});
