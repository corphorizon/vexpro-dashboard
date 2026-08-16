// ─────────────────────────────────────────────────────────────────────────────
// loadPersistedTotals — los retiros que se suman son los de CLIENTES.
//
// Reproduce el bug de Vex Pro (agosto 2026) con las cifras reales de prod:
// tres wallets pineadas, una operativa (1079 "VexPro Main Wallet",
// $469.650,98 de retiros) y dos internas de tesorería (1087 "Savings Vex Pro"
// $400.014,00 y 1705 "Egresos Vex" $62.779,85). Sumadas las tres daban
// Retiros Totales $932.444,83 y un Net Deposit de −$231.127 que se iba
// derecho a la cadena de distribución.
//
// Se mockea el admin client: ni una lectura contra prod.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Result = { data: unknown; error: { message: string } | null };

let tableResults: Record<string, Result> = {};

/** Cadena de PostgREST que responde lo mismo se encadene lo que se encadene. */
function chainable(result: Result) {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'lte', 'or', 'order', 'limit', 'in']) {
    chain[m] = () => chain;
  }
  chain.then = (
    onOk: (v: Result) => unknown,
    onErr?: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(onOk, onErr);
  return chain;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) =>
      chainable(tableResults[table] ?? { data: [], error: null }),
  }),
}));

import { loadPersistedTotals } from './persistence';

const COMPANY = '71715987-5479-52c4-a990-c414fb3a9b36'; // Vex Pro

const W = (wallet_id: string, amount: number) => ({
  provider: 'coinsbuy-withdrawals',
  amount,
  status: 'Approved',
  transaction_date: '2026-08-10T00:00:00.000Z',
  wallet_id,
  internal: false,
});

const D = (wallet_id: string, amount: number) => ({
  provider: 'coinsbuy-deposits',
  amount,
  status: 'Confirmed',
  transaction_date: '2026-08-10T00:00:00.000Z',
  wallet_id,
  internal: false,
});

beforeEach(() => {
  tableResults = {
    pinned_coinsbuy_wallets: {
      data: [
        { wallet_id: '1079', wallet_label: 'VexPro Main Wallet', role: 'operating' },
        { wallet_id: '1087', wallet_label: 'Savings Vex Pro', role: 'internal' },
        { wallet_id: '1705', wallet_label: 'Egresos Vex', role: 'internal' },
      ],
      error: null,
    },
    api_transactions: {
      data: [
        W('1079', 469_650.98),
        W('1087', 400_014),
        W('1705', 62_779.85),
        D('1079', 700_000),
        D('1087', 50_000), // un ingreso a la wallet de ahorro no es un depósito de cliente
      ],
      error: null,
    },
    api_sync_log: { data: [{ last_synced_at: '2026-08-16T12:00:00.000Z' }], error: null },
  };
});

describe('loadPersistedTotals — wallets internas', () => {
  it('los retiros a Savings y Egresos NO entran en Retiros Totales', async () => {
    const totals = await loadPersistedTotals(COMPANY, '2026-08-01', '2026-08-31');
    // Antes del fix: 932_444.83
    expect(totals.withdrawalsTotal).toBeCloseTo(469_650.98, 2);
  });

  it('tampoco entran del lado de los depósitos', async () => {
    const totals = await loadPersistedTotals(COMPANY, '2026-08-01', '2026-08-31');
    expect(totals.depositsTotal).toBeCloseTo(700_000, 2);
  });

  it('con las internas fuera, el Net Deposit de agosto vuelve a ser positivo', async () => {
    const totals = await loadPersistedTotals(COMPANY, '2026-08-01', '2026-08-31');
    expect(totals.depositsTotal - totals.withdrawalsTotal).toBeGreaterThan(0);
  });

  it('una empresa sin wallets pineadas sigue contando todo (fallback legacy)', async () => {
    tableResults.pinned_coinsbuy_wallets = { data: [], error: null };
    const totals = await loadPersistedTotals(COMPANY, '2026-08-01', '2026-08-31');
    expect(totals.withdrawalsTotal).toBeCloseTo(932_444.83, 2);
  });

  it('si TODAS las pineadas son internas no cuenta ninguna (no vuelve a "todas")', async () => {
    // Marcar como interna la última operativa es una decisión explícita del
    // admin. El fallback permisivo solo aplica a empresas sin pins.
    tableResults.pinned_coinsbuy_wallets = {
      data: [{ wallet_id: '1087', wallet_label: 'Savings Vex Pro', role: 'internal' }],
      error: null,
    };
    const totals = await loadPersistedTotals(COMPANY, '2026-08-01', '2026-08-31');
    expect(totals.withdrawalsTotal).toBe(0);
    expect(totals.depositsTotal).toBe(0);
  });

  it('las transferencias internas entre wallets propias siguen sin contar', async () => {
    tableResults.api_transactions = {
      data: [{ ...W('1079', 30_000), internal: true }, W('1079', 1_000)],
      error: null,
    };
    const totals = await loadPersistedTotals(COMPANY, '2026-08-01', '2026-08-31');
    expect(totals.withdrawalsTotal).toBeCloseTo(1_000, 2);
  });
});
