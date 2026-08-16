// ─────────────────────────────────────────────────────────────────────────────
// Rol de las wallets pineadas — lo que protegen estos tests es plata.
//
// Vex Pro, agosto 2026: /movimientos mostraba Retiros Totales $932.444,83 y
// Net Deposit −$231.127 porque contaba como retiros de clientes los giros a
// dos wallets INTERNAS de la empresa — 1087 "Savings Vex Pro" ($400.014,00,
// 2 tx) y 1705 "Egresos Vex" ($62.779,85, 22 tx). Los retiros reales, los de
// la wallet operativa 1079 "VexPro Main Wallet", eran $469.650,98. Ese Net
// Deposit inflado en negativo era el que consumía la cadena de distribución.
//
// La regla que se fija acá: balance cuenta TODAS las pineadas; movimientos
// cuenta SOLO las operativas.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Filas tal como las devuelve prod para Vex Pro después de la migración 084.
const VEXPRO_PINS = [
  { wallet_id: '1079', wallet_label: 'VexPro Main Wallet', role: 'operating' },
  { wallet_id: '1087', wallet_label: 'Savings Vex Pro', role: 'internal' },
  { wallet_id: '1705', wallet_label: 'Egresos Vex', role: 'internal' },
];

let pinnedRows: Array<Record<string, unknown>> = [];
let pinnedError: { message: string } | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        eq: async () => ({ data: pinnedRows, error: pinnedError }),
      }),
    }),
  }),
}));

import {
  getBalanceWalletIds,
  getOperatingWalletIds,
  fetchPinnedWallets,
} from './pinned-wallets';
import {
  normalizePinnedWalletRole,
  selectOperatingWallets,
} from './pinned-wallet-roles';

const COMPANY = '71715987-5479-52c4-a990-c414fb3a9b36'; // Vex Pro

beforeEach(() => {
  pinnedRows = VEXPRO_PINS.map((r) => ({ ...r }));
  pinnedError = null;
});

describe('normalizePinnedWalletRole', () => {
  it('una fila anterior a la migración 084 (sin columna) es operativa', () => {
    // Es el rol que ya tenía de hecho: estaba contando para los totales.
    expect(normalizePinnedWalletRole(undefined)).toBe('operating');
    expect(normalizePinnedWalletRole(null)).toBe('operating');
  });

  it('cualquier valor raro cae en operativa, nunca en interna', () => {
    // Fallar hacia "interna" escondería plata del Net Deposit en silencio.
    expect(normalizePinnedWalletRole('OPERATING')).toBe('operating');
    expect(normalizePinnedWalletRole(42)).toBe('operating');
    expect(normalizePinnedWalletRole('internal')).toBe('internal');
  });
});

describe('selectOperatingWallets', () => {
  it('una operativa + dos internas → queda una', () => {
    expect(selectOperatingWallets(VEXPRO_PINS).map((w) => w.wallet_id)).toEqual(['1079']);
  });
});

describe('getOperatingWalletIds / getBalanceWalletIds', () => {
  it('movimientos cuenta SOLO la operativa (1079), no Savings ni Egresos', async () => {
    expect(await getOperatingWalletIds(COMPANY)).toEqual(['1079']);
  });

  it('balance cuenta las tres: la plata interna también es de la empresa', async () => {
    expect(await getBalanceWalletIds(COMPANY)).toEqual(['1079', '1087', '1705']);
  });

  it('admite VARIAS operativas', async () => {
    pinnedRows = [
      { wallet_id: '1079', wallet_label: 'Main', role: 'operating' },
      { wallet_id: '2000', wallet_label: 'Main 2', role: 'operating' },
      { wallet_id: '1087', wallet_label: 'Savings', role: 'internal' },
    ];
    expect(await getOperatingWalletIds(COMPANY)).toEqual(['1079', '2000']);
  });

  it('una empresa con solo su Main pineada (sin rol en la fila) no cambia', async () => {
    // El default de la columna es 'operating' justamente para esto: el resto
    // de los tenants tiene una única wallet pineada y es la operativa.
    pinnedRows = [{ wallet_id: '9001', wallet_label: 'Main' }];
    expect(await getOperatingWalletIds(COMPANY)).toEqual(['9001']);
    expect(await getBalanceWalletIds(COMPANY)).toEqual(['9001']);
  });

  it('si la query falla devuelve vacío en vez de reventar la pantalla', async () => {
    pinnedError = { message: 'boom' };
    pinnedRows = [];
    expect(await fetchPinnedWallets(COMPANY)).toEqual([]);
  });
});
