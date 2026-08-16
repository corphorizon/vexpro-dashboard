import { createAdminClient } from '@/lib/supabase/admin';
import {
  normalizePinnedWalletRole,
  selectOperatingWallets,
  type PinnedWalletRole,
} from '@/lib/pinned-wallet-roles';

// ─────────────────────────────────────────────────────────────────────────────
// Wallets pineadas de Coinsbuy — REGISTRO ÚNICO (server-side).
//
// Cada wallet pineada tiene un ROL (migración 084; el porqué completo está en
// `pinned-wallet-roles.ts`):
//   · 'operating' → cuenta para movimientos Y para balance
//   · 'internal'  → SOLO balance (ahorro, pago de egresos, tesorería propia)
//
// La regla, entonces:
//   · BALANCE      → getBalanceWalletIds()   (TODAS las pineadas)
//   · MOVIMIENTOS  → getOperatingWalletIds() (solo role='operating')
//     ("movimientos" = /movimientos, Net Deposit, reportes de depósitos y
//      retiros, y todo lo que alimente la cadena de distribución)
//
// NINGÚN consumidor debe volver a leer `pinned_coinsbuy_wallets` directo: el
// modo de falla #1 de este repo son las listas duplicadas que se desincronizan
// en silencio, y el bug de agosto 2026 fue exactamente eso.
// ─────────────────────────────────────────────────────────────────────────────

export {
  normalizePinnedWalletRole,
  selectOperatingWallets,
  PINNED_WALLET_ROLES,
} from '@/lib/pinned-wallet-roles';
export type { PinnedWalletRole } from '@/lib/pinned-wallet-roles';

export interface PinnedWallet {
  wallet_id: string;
  wallet_label: string;
  role: PinnedWalletRole;
}

type PinnedRow = { wallet_id: unknown; wallet_label?: unknown; role?: unknown };

/**
 * TODAS las wallets pineadas de la empresa, con su rol normalizado.
 * Server-side (admin client) — el equivalente de cliente es
 * `fetchPinnedCoinsbuyWallets` en supabase/queries.ts.
 */
export async function fetchPinnedWallets(companyId: string): Promise<PinnedWallet[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('pinned_coinsbuy_wallets')
    .select('wallet_id, wallet_label, role')
    .eq('company_id', companyId);

  if (error) {
    console.error('[pinned-wallets] query failed:', error.message);
    return [];
  }

  return ((data ?? []) as PinnedRow[]).map((r) => ({
    wallet_id: String(r.wallet_id),
    wallet_label: typeof r.wallet_label === 'string' ? r.wallet_label : '',
    role: normalizePinnedWalletRole(r.role),
  }));
}

/**
 * BALANCE — todas las wallets pineadas, sin importar el rol. Las internas
 * también son plata de la empresa: tienen que sumar al consolidado.
 */
export async function getBalanceWalletIds(companyId: string): Promise<string[]> {
  return (await fetchPinnedWallets(companyId)).map((w) => w.wallet_id);
}

/**
 * MOVIMIENTOS / NET DEPOSIT / DISTRIBUCIÓN — solo las operativas. Un giro a
 * la wallet de ahorro o a la de egresos no es un retiro de cliente y no puede
 * restarle al Net Deposit que después se reparte.
 */
export async function getOperatingWalletIds(companyId: string): Promise<string[]> {
  return selectOperatingWallets(await fetchPinnedWallets(companyId)).map(
    (w) => w.wallet_id,
  );
}

/**
 * Igual que getOperatingWalletIds pero distinguiendo los dos motivos por los
 * que la lista puede venir vacía:
 *   · `scoped: false` → la empresa NO tiene NINGUNA wallet pineada. Es el
 *     estado de todos los tenants menos Vex Pro: no hay nada configurado, así
 *     que los consumidores siguen contando todo (fallback histórico).
 *   · `scoped: true` con `ids: []` → hay wallets pineadas pero TODAS son
 *     internas. Eso es una decisión explícita del admin: no debe contar nada.
 *
 * La diferencia importa: sin ella, marcar como interna la última wallet
 * operativa hacía que los totales pasaran de "solo la Main" a "TODAS las
 * wallets de la cuenta" — exactamente al revés de lo que pidió el usuario, y
 * en silencio.
 */
export async function getOperatingWalletScope(
  companyId: string,
): Promise<{ ids: string[]; scoped: boolean }> {
  const pins = await fetchPinnedWallets(companyId);
  return {
    ids: selectOperatingWallets(pins).map((w) => w.wallet_id),
    scoped: pins.length > 0,
  };
}
