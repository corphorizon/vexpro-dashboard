// ─────────────────────────────────────────────────────────────────────────────
// Saldo EN VIVO por canal automático — una sola puerta (server-only).
//
// POR QUÉ EXISTE (2026-08-31, auditoría de finanzas, ítem 14)
// `/api/balances/total-consolidado` refrescaba en vivo DOS canales, coinsbuy y
// unipayment, con dos ramas escritas a mano en el bucle. Medido ese día en Vex
// Pro: Pay-Pros tenía $39.944 y mostraba el saldo del libro de anoche;
// UniPayment tenía $21 y se refrescaba. La tarjeta de la home dice «ahora
// mismo» y era mentira justo para el canal grande.
//
// La raíz es la de siempre: una lista de canales escrita en un `if/else` en vez
// de derivada. Acá vive el mapa clave → fetcher, y su cobertura se valida
// contra `LIVE_BALANCE_CHANNELS` (src/lib/api-channels.ts) con un test: un
// canal automático nuevo con `liveBalance: true` y sin fetcher rompe el test
// en vez de quedarse callado mostrando el saldo de ayer.
//
// CONTRATO: `null` = NO LO SABEMOS (sin credenciales, API caída, timeout,
// respuesta rara). NUNCA 0 — un cero se lee como «el canal está vacío» y ese es
// el fallo que no da error de §1.2. Quien recibe `null` cae al libro/snapshot,
// que es un dato viejo pero verdadero.
//
// COINSBUY es el único con una regla propia: sólo suman las wallets FIJADAS.
// Sin ninguna fijada devuelve `null` a propósito, para no inventar un total
// ambiguo con todas las wallets de la cuenta (que incluyen las de otros
// tenants del mismo login).
// ─────────────────────────────────────────────────────────────────────────────

import 'server-only';

import { fetchCoinsbuyWallets } from './coinsbuy/wallets';
import { fetchUnipaymentBalances } from './unipayment/balances';
import { fetchFairpayBalances } from './fairpay/balances';
import { fetchPayprosBalance } from './paypros/balance';
import { getBalanceWalletIds } from '@/lib/pinned-wallets';
import { LIVE_BALANCE_CHANNELS } from '@/lib/api-channels';

/** `null` = no lo sabemos. Nunca 0 por defecto. */
export type LiveBalance = number | null;

export type LiveBalanceFetcher = (companyId: string) => Promise<LiveBalance>;

const LIVE_BALANCE_FETCHERS: Record<string, LiveBalanceFetcher> = {
  coinsbuy: async (companyId) => {
    const [res, pinnedIds] = await Promise.all([
      fetchCoinsbuyWallets(companyId),
      getBalanceWalletIds(companyId),
    ]);
    const wallets = (res as { wallets?: Array<{ id: string; balanceConfirmed?: number }> }).wallets;
    if (!Array.isArray(wallets)) return null;
    const pinned = new Set(pinnedIds);
    if (pinned.size === 0) return null;
    return wallets
      .filter((w) => pinned.has(w.id))
      .reduce((s, w) => s + (w.balanceConfirmed ?? 0), 0);
  },

  unipayment: async (companyId) => {
    const res = await fetchUnipaymentBalances(companyId);
    if (res.error || !Array.isArray(res.balances)) return null;
    return res.balances.reduce((s, b) => s + (b.availableBalance ?? 0), 0);
  },

  fairpay: async (companyId) => {
    const res = await fetchFairpayBalances(companyId);
    // `balances: []` sin error significa "el banking no devolvió la cuenta
    // elegida": tampoco lo sabemos. Sumarlo como 0 borraría los $7.163,47 que
    // el libro sí tiene bien.
    if (res.error || res.balances.length === 0) return null;
    return res.balances.reduce((s, b) => s + (b.availableBalance ?? 0), 0);
  },

  paypros: async (companyId) => {
    const res = await fetchPayprosBalance(companyId);
    if (res.error || res.balance === null) return null;
    return res.balance;
  },
};

/**
 * Canales del registro que NO tienen fetcher, y fetchers que no corresponden a
 * ningún canal `liveBalance`. Las dos direcciones son errores distintos y por
 * eso se devuelven separadas — lo consume el test del registro.
 */
export function liveBalanceCoverageDrift(): {
  missingFetchers: string[];
  orphanFetchers: string[];
} {
  const withFetcher = new Set(Object.keys(LIVE_BALANCE_FETCHERS));
  return {
    missingFetchers: LIVE_BALANCE_CHANNELS.filter((k) => !withFetcher.has(k)).sort(),
    orphanFetchers: [...withFetcher].filter((k) => !LIVE_BALANCE_CHANNELS.includes(k)).sort(),
  };
}

export interface LiveBalancesResult {
  /** Saldo por canal. Sólo entran los canales que respondieron un número. */
  byChannel: Map<string, number>;
  /** Canales que se intentaron y NO se pudieron leer. Se informan, no se ocultan. */
  unavailable: string[];
}

/**
 * Lee en paralelo el saldo de todos los canales `liveBalance` del registro, con
 * un timeout por canal. Un proveedor caído nunca puede bajar el total a cero:
 * su canal queda fuera de `byChannel` y el caller usa libro/snapshot.
 */
export async function fetchLiveChannelBalances(
  companyId: string,
  opts: { timeoutMs?: number } = {},
): Promise<LiveBalancesResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const byChannel = new Map<string, number>();
  const unavailable: string[] = [];

  const withTimeout = (p: Promise<LiveBalance>): Promise<LiveBalance> =>
    Promise.race([
      p,
      new Promise<LiveBalance>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

  const keys = LIVE_BALANCE_CHANNELS.filter((k) => LIVE_BALANCE_FETCHERS[k]);
  const results = await Promise.allSettled(
    keys.map((k) => withTimeout(LIVE_BALANCE_FETCHERS[k](companyId))),
  );

  keys.forEach((key, i) => {
    const r = results[i];
    const value = r.status === 'fulfilled' ? r.value : null;
    if (value === null || !Number.isFinite(value)) unavailable.push(key);
    else byChannel.set(key, value);
  });

  return { byChannel, unavailable };
}
