// ─────────────────────────────────────────────────────────────────────────────
// Rol de una wallet pineada de Coinsbuy — vocabulario compartido.
//
// Vive separado de `pinned-wallets.ts` porque aquel importa el admin client
// (`server-only`) y esto lo necesitan también la UI de /balances y el banner
// de /movimientos. Acá no hay acceso a datos: solo el tipo, el normalizador y
// el filtro puro. El registro de "qué wallets cuentan" sigue siendo uno solo
// (pinned-wallets.ts en el server, fetchPinnedCoinsbuyWallets en el cliente).
//
// EL PORQUÉ (bug de dinero, Vex Pro, agosto 2026)
// -----------------------------------------------
// `pinned_coinsbuy_wallets` mezclaba dos significados en una sola marca:
//   (a) "esta wallet SUMA al balance consolidado"     → /balances
//   (b) "esta wallet cuenta como depósitos/retiros de CLIENTES"
//                                                     → /movimientos,
//                                                       Net Deposit,
//                                                       cadena de distribución
// Mientras la única pineada fue 1079 "VexPro Main Wallet" ambos criterios
// coincidían. Al pinnear 1087 "Savings Vex Pro" ($400.014,00, 2 tx) y 1705
// "Egresos Vex" ($62.779,85, 22 tx) para que sumaran al BALANCE,
// /movimientos se las llevó puestas: Retiros Totales $932.444,83 en vez de
// los $469.650,98 de la operativa, y Net Deposit −$231.127.
// ─────────────────────────────────────────────────────────────────────────────

export type PinnedWalletRole = 'operating' | 'internal';

export const PINNED_WALLET_ROLES: readonly PinnedWalletRole[] = [
  'operating',
  'internal',
] as const;

/**
 * Normaliza el rol leído de la DB. Las filas escritas ANTES de la migración
 * 084 no traen la columna (o traen null): esas son justamente las que ya
 * estaban contando para los totales, así que su rol histórico es 'operating'.
 * Mismo default que la columna, para que código y DB no discrepen.
 */
export function normalizePinnedWalletRole(raw: unknown): PinnedWalletRole {
  return raw === 'internal' ? 'internal' : 'operating';
}

/** Filtro puro — solo las wallets operativas (las que cuentan como clientes). */
export function selectOperatingWallets<T extends { role?: unknown }>(rows: T[]): T[] {
  return rows.filter((r) => normalizePinnedWalletRole(r.role) === 'operating');
}
