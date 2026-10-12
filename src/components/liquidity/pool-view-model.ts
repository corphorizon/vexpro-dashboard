// ─────────────────────────────────────────────────────────────────────────────
// Decisiones de presentación del Pool de Liquidez (rediseño «Libro mayor»,
// 2026-10-12). Puras y con test; la vista sólo las dibuja.
//
// · `toAmount`: las columnas numéricas llegan del endpoint como número o como
//   texto (la vista ya hacía `Number(c.balance_liquidez)` en los totales). Un
//   `<Money>` con texto mostraría «—» — un saldo real que desaparece. `null`
//   y lo no numérico siguen siendo «sin dato», nunca 0.
// · `poolStatusKind`: active = al día (`ok`), error = `bad`, el resto neutro.
// · `connectionEquityTag`: el «manual» / «aprox.» que acompaña al equity a la
//   conexión. Con posiciones abiertas ese día el número es el balance, no el
//   equity, y se dice (reglas §3.2 L7).
// · `poolTotals`: los totales de la franja. Son los mismos que antes
//   (`Number(x) || 0` por cuenta) — no se cambia qué suma el pool, sólo dónde
//   se ve.
// ─────────────────────────────────────────────────────────────────────────────

import type { StatusKind } from '@/components/ui/status-kind';

export function toAmount(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export type PoolStatus = 'active' | 'inactive' | 'error';

export function poolStatusKind(status: PoolStatus | string | null | undefined): StatusKind {
  if (status === 'active') return 'ok';
  if (status === 'error') return 'bad';
  return 'neutral';
}

export function connectionEquityTag(c: {
  connection_values_manual: boolean;
  connection_open_positions: number | null;
}): 'manual' | 'approx' | null {
  if (c.connection_values_manual) return 'manual';
  if (typeof c.connection_open_positions === 'number' && c.connection_open_positions > 0) return 'approx';
  return null;
}

export interface PoolTotals {
  total: number;
  active: number;
  inactive: number;
  /** Σ Equity a Liquidez: lo que manda. */
  pool: number;
  /** Σ Balance MT5: la referencia. */
  mt5: number;
}

export function poolTotals(
  cuentas: Array<{ status: string; balance: unknown; balance_liquidez: unknown }>,
): PoolTotals {
  return {
    total: cuentas.length,
    active: cuentas.filter((c) => c.status === 'active').length,
    inactive: cuentas.filter((c) => c.status !== 'active').length,
    pool: cuentas.reduce((s, c) => s + (Number(c.balance_liquidez) || 0), 0),
    mt5: cuentas.reduce((s, c) => s + (Number(c.balance) || 0), 0),
  };
}

/** El aporte al pool difiere del balance MT5 (parte ya estaba contada en otra cuenta). */
export function differsFromMt5(c: { balance: unknown; balance_liquidez: unknown }): boolean {
  return Number(c.balance_liquidez) !== Number(c.balance);
}
