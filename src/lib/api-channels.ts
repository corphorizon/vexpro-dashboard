// ─────────────────────────────────────────────────────────────────────────────
// Canales AUTOMÁTICOS y proveedores de API — registro único, fase 2.
//
// POR QUÉ EXISTE ESTE ARCHIVO (2026-08-31, auditoría de finanzas, ítem 14)
// La tanda 1 derivó `API_LEDGER_CHANNELS` de `BUILTIN_CHANNELS`: qué canal
// lleva libro automático dejó de ser una lista escrita a mano. Pero el resto
// de los datos POR CANAL seguía repartido en cinco archivos que no se hablan,
// y las cinco copias ya habían divergido en producción:
//
//   1. `MAX_ADJUSTMENT` (channel-ledger-sync.ts) — un Record literal. Un canal
//      `auto` nuevo caía al `DEFAULT_MAX_ADJUSTMENT` de 1.000 sin que nadie lo
//      decidiera, y con eso su libro se congelaba la primera noche que se
//      moviera más de mil dólares. Es exactamente lo que le pasó a Coinsbuy con
//      un tope de 500 (10 días, $91.756,14 de brecha).
//   2. `PROVIDER_LABELS` (integrations-sync.ts) — NO tenía `paypros`, que entró
//      el 2026-07-22: un fallo de sincronización de Pay-Pros llegaba al aviso
//      como la cadena cruda «paypros».
//   3. `SLUG_LABEL` / `SLUG_ACCENT` (realtime-movements-banner.tsx) — dos
//      Records exhaustivos por `ProviderSlug` en un archivo de UI.
//   4. `['coinsbuy','unipayment']` (api/admin/channel-configs/route.ts + el
//      modal de /balances) — la lista de "canales que no se pueden renombrar",
//      escrita DOS veces, cliente y servidor, con dos ítems, cuando ya había
//      cuatro canales automáticos. FairPay y Pay-Pros eran renombrables.
//   5. El refresh EN VIVO de `/api/balances/total-consolidado` cubría
//      `coinsbuy` y `unipayment` y nada más. Medido el 2026-08-31: Pay-Pros
//      con $39.944 mostraba el saldo del libro de anoche y UniPayment con $21
//      se refrescaba. La tarjeta de la home decía "ahora mismo" sobre un
//      número de ayer, para el canal más grande de los dos.
//
// Es el modo de falla número uno del repo (docs/reglas-del-proyecto.md §1.1)
// cinco veces sobre el mismo dato. Acá vive UNA fila por canal automático y UNA
// por slug de proveedor; los cinco lugares las leen.
//
// CLIENT-SAFE a propósito: no importa Supabase ni ningún fetcher. Los fetchers
// del saldo en vivo viven en `api-integrations/live-balances.ts` (servidor) y
// se validan contra ESTE registro.
// ─────────────────────────────────────────────────────────────────────────────

import { BUILTIN_CHANNELS } from './channel-configs';
import { API_LEDGER_CHANNELS } from './channel-ledger';
import type { ProviderSlug } from './api-integrations/types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Canales de libro automático (clave de `channel_configs.channel_key`)
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiChannelDef {
  /** Clave built-in. Tiene que estar en `API_LEDGER_CHANNELS`. */
  key: string;
  /**
   * Tope de ajuste diario del libro, en dólares. El porqué de cada número está
   * en la cabecera de `MAX_ADJUSTMENT` (channel-ledger-sync.ts), que ahora se
   * DERIVA de acá. Es obligatorio: un canal automático sin tope propio es un
   * canal cuyo libro se congela solo.
   */
  maxAdjustment: number;
  /**
   * `true` → el proveedor informa el SALDO pero no los movimientos, así que el
   * día se asienta con UNA línea («Variación del saldo»). Hoy sólo FairPay.
   */
  noMovementFeed?: boolean;
  /**
   * `true` → hay un fetcher de saldo en vivo para este canal, y por lo tanto
   * `/api/balances/total-consolidado` puede (y debe) refrescarlo en la lectura
   * en vez de mostrar el saldo del libro de anoche.
   */
  liveBalance: boolean;
  /**
   * Slugs de `api_transactions.provider` que alimentan el libro de este canal.
   * `[]` cuando no hay extracto (FairPay). Coinsbuy tiene dos —depósitos y
   * retiros— porque la API es una sola y los sentidos se separan por slug.
   */
  movementSlugs: readonly ProviderSlug[];
}

/**
 * Los cuatro canales automáticos con saldo por API, en el orden de
 * `BUILTIN_CHANNELS`.
 *
 * ⚠ `inversiones` y `liquidez` son `auto` pero NO llevan libro acá
 * (NON_LEDGER_CHANNELS): su saldo se reconstruye desde su propio módulo. Por
 * eso el contraste es contra `API_LEDGER_CHANNELS` y no contra
 * `BUILTIN_CHANNELS.filter(type === 'auto')`.
 */
export const API_CHANNELS: readonly ApiChannelDef[] = [
  {
    key: 'coinsbuy',
    maxAdjustment: 150_000,
    liveBalance: true,
    movementSlugs: ['coinsbuy-deposits', 'coinsbuy-withdrawals'],
  },
  {
    key: 'unipayment',
    maxAdjustment: 25_000,
    liveBalance: true,
    movementSlugs: ['unipayment'],
  },
  {
    key: 'fairpay',
    maxAdjustment: 25_000,
    noMovementFeed: true,
    liveBalance: true,
    // Vacío A PROPÓSITO: las filas `provider='fairpay'` son cobros del PORTAL,
    // otro sistema, y no movimientos de la cuenta bancaria de la que sale el
    // saldo. La migración 108 las saca de get_channel_day_movements. Ver la
    // cabecera de channel-ledger.ts.
    movementSlugs: [],
  },
  {
    key: 'paypros',
    maxAdjustment: 5_000,
    liveBalance: true,
    movementSlugs: ['paypros'],
  },
] as const;

const API_CHANNEL_BY_KEY = new Map(API_CHANNELS.map((c) => [c.key, c]));

/** Definición del canal automático, o `undefined` si no es uno. */
export function apiChannel(key: string): ApiChannelDef | undefined {
  return API_CHANNEL_BY_KEY.get(key);
}

/**
 * Claves de los canales cuyo saldo se puede refrescar EN VIVO desde una
 * pantalla. Lo consume `/api/balances/total-consolidado`.
 */
export const LIVE_BALANCE_CHANNELS: readonly string[] = API_CHANNELS.filter(
  (c) => c.liveBalance,
).map((c) => c.key);

/**
 * Canales built-in que NO se pueden renombrar: los automáticos.
 *
 * El nombre de un canal automático es el del proveedor, y el reporte, el aviso
 * y el libro lo usan para decir de dónde salió la plata. Renombrar «Pay-Pros» a
 * «Caja chica» rompe esa trazabilidad sin que falle nada.
 *
 * Hasta el 2026-08-31 esto era `['coinsbuy', 'unipayment']` escrito DOS veces
 * —servidor y modal— y desactualizado en las dos: FairPay y Pay-Pros, que son
 * igual de automáticos, se dejaban renombrar. Ahora se deriva.
 *
 * ⚠ NO es "todo built-in `auto`". `liquidez` e `inversiones` también son
 * `auto`, pero su nombre («Balance Actual Liquidez») es NUESTRO, no el de
 * ningún proveedor, y renombrarlos siempre estuvo permitido. La línea correcta
 * es la del PROVEEDOR EXTERNO, que es exactamente `API_LEDGER_CHANNELS`.
 */
export const NON_RENAMABLE_BUILTIN_CHANNELS: readonly string[] = BUILTIN_CHANNELS.filter(
  (c) => API_LEDGER_CHANNELS.has(c.key),
).map((c) => c.key);

export function canRenameChannel(key: string, isCustom: boolean): boolean {
  if (isCustom) return true;
  return !NON_RENAMABLE_BUILTIN_CHANNELS.includes(key);
}

/**
 * Los canales del registro que NO están en `API_LEDGER_CHANNELS`, y al revés.
 *
 * Existe para que el desvío se pueda TESTEAR y no se descubra en producción:
 * agregar un built-in `auto` nuevo sin darle tope de ajuste rompe el test en
 * vez de darle en silencio un tope de 1.000 dólares. Devuelve las dos
 * direcciones porque las dos son errores distintos:
 *   · `missingFromRegistry` → canal con libro automático y sin tope propio.
 *   · `unknownChannels`     → fila acá para un canal que ya no lleva libro.
 */
export function apiChannelRegistryDrift(): {
  missingFromRegistry: string[];
  unknownChannels: string[];
} {
  const registered = new Set(API_CHANNELS.map((c) => c.key));
  return {
    missingFromRegistry: [...API_LEDGER_CHANNELS].filter((k) => !registered.has(k)).sort(),
    unknownChannels: API_CHANNELS.map((c) => c.key)
      .filter((k) => !API_LEDGER_CHANNELS.has(k))
      .sort(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Proveedores (clave de `api_transactions.provider` = `ProviderSlug`)
//
// Un canal puede tener DOS slugs (Coinsbuy: depósitos y retiros salen del mismo
// fetch pero son dos tarjetas), así que esta tabla no se puede derivar de la de
// arriba. `Record<ProviderSlug, …>` a propósito: agregar un slug ROMPE la
// compilación acá, que es donde tiene que romperse.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderMeta {
  /** Nombre del PROVEEDOR, sin el sentido. Coinsbuy es «Coinsbuy» en los dos. */
  provider: string;
  /** Etiqueta de la tarjeta de /movimientos, con el sentido. */
  cardLabel: string;
  /** Clase Tailwind del importe en la tarjeta. */
  accent: string;
  /** 'in' = entra plata; 'out' = sale. */
  direction: 'in' | 'out';
}

export const PROVIDER_META: Record<ProviderSlug, ProviderMeta> = {
  'coinsbuy-deposits': {
    provider: 'Coinsbuy',
    cardLabel: 'Coinsbuy · Depósitos',
    accent: 'text-info',
    direction: 'in',
  },
  'coinsbuy-withdrawals': {
    provider: 'Coinsbuy',
    cardLabel: 'Coinsbuy · Retiros',
    accent: 'text-negative',
    direction: 'out',
  },
  fairpay: {
    provider: 'FairPay',
    cardLabel: 'FairPay · Depósitos',
    accent: 'text-positive',
    direction: 'in',
  },
  unipayment: {
    provider: 'UniPayment',
    cardLabel: 'Unipayment · Depósitos',
    accent: 'text-violet-600 dark:text-violet-400',
    direction: 'in',
  },
  paypros: {
    provider: 'Pay-Pros',
    cardLabel: 'Pay-Pros · Depósitos',
    accent: 'text-amber-600 dark:text-amber-400',
    direction: 'in',
  },
};

/**
 * Nombre legible de un proveedor para un aviso. Acepta cualquier string porque
 * `integrations-sync` también sincroniza `orion_crm`, que no es un
 * `ProviderSlug`; lo desconocido vuelve tal cual en vez de perderse.
 */
export function providerLabel(slug: string): string {
  return PROVIDER_META[slug as ProviderSlug]?.provider ?? EXTRA_PROVIDER_LABELS[slug] ?? slug;
}

/** Fuentes que sincroniza el cron y NO son un proveedor de pagos. */
const EXTRA_PROVIDER_LABELS: Record<string, string> = {
  orion_crm: 'Orion CRM',
};
