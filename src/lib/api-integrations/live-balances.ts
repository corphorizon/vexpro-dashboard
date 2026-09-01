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
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchOnchainTotal } from '@/lib/api-integrations/onchain/usdt-balance';
import { fetchNativePrices } from '@/lib/api-integrations/onchain/prices';
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

  // ── Canales ON-CHAIN (Kevin, 2026-09-01: «la trust wallet no está
  // sincronizada en vex») ───────────────────────────────────────────────────
  // No estaba desincronizada: se leía UNA vez al día en el cron de medianoche
  // y la pantalla mostraba esa foto todo el día. Medido el 2026-09-01: el
  // snapshot de las 00:01 UTC decía 80.539,70 USDT en Tron y a las 12:00 la
  // cadena tenía 14.807,54 — 65.732 salieron después de la foto. Un saldo de
  // 12 horas de antigüedad presentado como el saldo de hoy es exactamente el
  // fallo que no da error.
  //
  // La clave del canal es dinámica (wallet_externa o cualquier custom_* con
  // direcciones), así que este fetcher no vive en el Record de arriba: se
  // resuelve leyendo `channel_configs.onchain_wallets`, igual que el cron.
};

/** Saldo en vivo de cada canal con direcciones on-chain configuradas. */
async function fetchOnchainLiveBalances(
  companyId: string,
): Promise<{ byChannel: Map<string, number>; unavailable: string[] }> {
  const byChannel = new Map<string, number>();
  const unavailable: string[] = [];
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('channel_configs')
    .select('channel_key, onchain_wallets')
    .eq('company_id', companyId)
    .not('onchain_wallets', 'is', null);
  if (error || !data) return { byChannel, unavailable };

  // Los precios del gas se leen UNA vez para todos los canales.
  // `fetchNativePrices` devuelve {prices, at} o {error}: se pasa solo el mapa.
  const priceRes = await fetchNativePrices().catch(() => ({}) as Record<string, never>);
  const prices = ('prices' in priceRes ? priceRes.prices : {}) as Parameters<typeof fetchOnchainTotal>[1] extends { prices?: infer P } ? P : never;
  for (const row of data as Array<{ channel_key: string; onchain_wallets: unknown }>) {
    const wallets = Array.isArray(row.onchain_wallets) ? row.onchain_wallets : [];
    if (wallets.length === 0) continue;
    try {
      const r = await fetchOnchainTotal(wallets as never, { prices });
      // `error` o total no numérico ⇒ el canal cae a libro/snapshot y se
      // informa: nunca un 0 que borre el saldo real.
      if (r.error || typeof r.total !== 'number' || !Number.isFinite(r.total)) {
        unavailable.push(row.channel_key);
      } else {
        byChannel.set(row.channel_key, r.total);
      }
    } catch {
      unavailable.push(row.channel_key);
    }
  }
  return { byChannel, unavailable };
}

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
  opts: { timeoutMs?: number; onlyOnchain?: boolean } = {},
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

  // `onlyOnchain`: la pantalla /balances ya resuelve los PSP por su cuenta y
  // solo necesita el on-chain — pedir los cuatro sería gastar cuatro llamadas
  // a proveedores para tirarlas.
  const keys = opts.onlyOnchain
    ? []
    : LIVE_BALANCE_CHANNELS.filter((k) => LIVE_BALANCE_FETCHERS[k]);
  const results = await Promise.allSettled(
    keys.map((k) => withTimeout(LIVE_BALANCE_FETCHERS[k](companyId))),
  );

  keys.forEach((key, i) => {
    const r = results[i];
    const value = r.status === 'fulfilled' ? r.value : null;
    if (value === null || !Number.isFinite(value)) unavailable.push(key);
    else byChannel.set(key, value);
  });

  // Canales on-chain: mismo contrato (un fallo informa, no pone cero). Van
  // aparte porque su clave sale de los datos, no del registro estático.
  try {
    const onchain = await withTimeout(
      fetchOnchainLiveBalances(companyId) as unknown as Promise<LiveBalance>,
    ) as unknown as { byChannel: Map<string, number>; unavailable: string[] };
    for (const [k, v] of onchain.byChannel) byChannel.set(k, v);
    unavailable.push(...onchain.unavailable);
  } catch {
    // Sin lista de canales on-chain no se puede nombrar cuál falló; el caller
    // cae a libro/snapshot como siempre.
  }

  return { byChannel, unavailable };
}
