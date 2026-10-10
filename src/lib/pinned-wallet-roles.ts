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
export function selectOperatingWallets<T extends { role?: unknown }>(rows: readonly T[]): T[] {
  return rows.filter((r) => normalizePinnedWalletRole(r.role) === 'operating');
}

/**
 * Wallet con la que debe ARRANCAR el selector de /movimientos.
 *
 * EL PORQUÉ (bug de pantalla, AP Markets, 2026-10-05 → 10): la página persiste
 * cada cambio del selector en `companies.default_wallet_id`, y los controles de
 * fijar/rol viven en ese mismo selector. Para marcar 1804 "Expenses AP Markets"
 * como interna hubo que seleccionarla — y quedó guardada como default. Desde
 * entonces el banner abría en una wallet que NO recibe depósitos y la tarjeta
 * «Coinsbuy · Depósitos» mostraba $0,00 con tilde verde, mientras la 1362
 * "AP MARKETS" tenía 21 depósitos por $16.305,27 en octubre. Nadie vio un error:
 * el cero era plausible.
 *
 * La regla: una wallet INTERNA nunca es punto de partida si hay una operativa.
 * Si la preferida está fijada como interna (o no hay preferida), se arranca en
 * la primera operativa por orden de fijado. Si todavía no hay pins cargadas, o
 * la preferida no está fijada, se respeta la preferida: acá no se adivina.
 *
 * La excepción honesta: preferida interna y NINGUNA operativa fijada → se
 * devuelve la preferida tal cual. No hay nada mejor que ofrecer, y devolver ''
 * mandaría al fallback de "primera wallet de la API", que puede ser otra
 * interna. Mejor un $0 explicado por el texto del banner que un número de una
 * wallet elegida a ciegas.
 *
 * Es solo el ARRANQUE. Se descartó re-aplicar la regla en cada cambio de
 * selección: para fijar una wallet o cambiarle el rol hay que seleccionarla, y
 * rebotar al usuario la dejaría sin forma de gestionar una interna. Que una
 * interna no QUEDE como default lo bloquea /api/admin/wallet-preference (409) y
 * lo repara `pin_wallet_role` cuando el rol cambia a interna.
 */
export function resolveStartupWallet<T extends { wallet_id: string; role?: unknown }>(
  preferred: string,
  pins: readonly T[],
): string {
  if (pins.length === 0) return preferred;
  const operating = selectOperatingWallets(pins);
  const preferredPin = preferred ? pins.find((p) => p.wallet_id === preferred) : undefined;
  const preferredIsInternal =
    preferredPin !== undefined && normalizePinnedWalletRole(preferredPin.role) === 'internal';
  if (!preferred || preferredIsInternal) {
    return operating[0]?.wallet_id ?? preferred;
  }
  return preferred;
}

/**
 * Default de Movimientos DESPUÉS de que `walletId` pasó a rol INTERNO: la
 * primera operativa fijada, o null si no hay ninguna. Nunca la propia
 * `walletId` (acaba de volverse interna) ni una inventada.
 *
 * Va separada de resolveStartupWallet porque arrancar y persistir difieren
 * justo en el caso sin operativas: el banner puede quedarse en la interna (hay
 * texto en pantalla que explica que no cuenta), pero guardarla como default
 * repetiría el incidente de AP Markets al siguiente recargo. Y si la wallet ya
 * no está fijada (pestaña vieja), devuelve null: un default que apunta a una
 * wallet sin pin no tiene rol conocido, y eso no se adivina.
 */
export function nextDefaultAfterInternal<T extends { wallet_id: string; role?: unknown }>(
  walletId: string,
  pins: readonly T[],
): string | null {
  const picked = resolveStartupWallet(walletId, pins);
  return picked === walletId ? null : picked;
}
