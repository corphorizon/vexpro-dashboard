// ─────────────────────────────────────────────────────────────────────────────
// Canales de DEPÓSITO — registro único (canal ↔ proveedor de la API).
//
// POR QUÉ EXISTE ESTE ARCHIVO (2026-08-31)
// Kevin reportó que la tarjeta «Depósitos» de /movimientos «no está sumando
// paypros». No era un bug de cuentas: era una lista dura. El mismo par
// canal↔slug estaba escrito CUATRO veces, y las cuatro decían "tres canales":
//
//   1. `src/lib/use-api-coexistence.ts` — apiCoinsbuy / apiFairpay /
//      apiUnipayment y un `apiDepositsTotal(m1, m2, m3)` posicional.
//   2. `src/app/(dashboard)/movimientos/page.tsx` — `API_SLUG_MAP` + los tres
//      `manualX` + `ALL_CHANNELS`.
//   3. `src/app/(dashboard)/resumen-general/page.tsx` — los tres `manualX`.
//   4. `src/app/(dashboard)/_home/admin-home.tsx` — los tres `manualX`.
//
// Mientras tanto el BACKEND (`loadPersistedTotals`, en
// `api-integrations/persistence.ts`) sí contaba Pay-Pros desde el día uno. O
// sea: dos verdades para el mismo número, y la pantalla mostraba la que
// faltaba $44.653,95 (61 transacciones desde el 2026-07-22, Vex Pro).
//
// Es el modo de falla número uno del repo, tal cual está descripto en
// `docs/reglas-del-proyecto.md §1.1`. Este módulo es la lista única: si
// mañana entra otro proveedor, se agrega ACÁ (y en `ProviderSlug`, que es el
// registro del lado de las integraciones) y las cuatro pantallas lo heredan.
//
// El registro es CLIENT-SAFE a propósito: no importa Supabase ni nada de
// servidor, para que lo puedan usar las páginas del dashboard.
// ─────────────────────────────────────────────────────────────────────────────

import { CHANNEL_LABELS, type Deposit } from './types';
import type { ProviderSlug } from './api-integrations/types';

/** Clave del canal tal como se guarda en `deposits.channel`. */
export type DepositChannel = Deposit['channel'];

export interface ApiDepositChannel {
  /** Clave en la tabla `deposits` (carga manual). */
  channel: DepositChannel;
  /** Slug del proveedor en `api_transactions.provider`. */
  slug: ProviderSlug;
}

/**
 * Canales de depósito que tienen un proveedor de API detrás. El orden es el
 * de la tabla en pantalla.
 *
 * `paypros` no tiene todavía filas manuales (el CHECK de `deposits.channel`
 * lo habilita la migración 105), pero entra igual al registro: el patrón del
 * repo es que TODO canal de API pueda coexistir con una carga manual, y
 * `manualDepositsByChannel` ya devuelve 0 mientras no exista ninguna.
 */
export const API_DEPOSIT_CHANNELS: readonly ApiDepositChannel[] = [
  { channel: 'coinsbuy', slug: 'coinsbuy-deposits' },
  { channel: 'fairpay', slug: 'fairpay' },
  { channel: 'unipayment', slug: 'unipayment' },
  { channel: 'paypros', slug: 'paypros' },
] as const;

/**
 * Todos los canales de la tabla de Depósitos, en orden de pantalla: los de
 * API y después el manual puro ('other'), que no suma a «Depósitos Totales
 * (API)» pero sí al total de depósitos del período.
 */
export const ALL_DEPOSIT_CHANNELS: readonly DepositChannel[] = [
  ...API_DEPOSIT_CHANNELS.map((c) => c.channel),
  'other',
] as const;

/** Slug de API del canal, o null si el canal es manual puro. */
export function apiSlugForChannel(channel: DepositChannel): ProviderSlug | null {
  return API_DEPOSIT_CHANNELS.find((c) => c.channel === channel)?.slug ?? null;
}

/**
 * Monto manual cargado por canal para un período (0 cuando no hay fila).
 *
 * 0 y no null a propósito: acá «no cargó nada a mano» ES cero pesos cargados
 * a mano; la incertidumbre no existe en esta tabla porque la ausencia de fila
 * es la forma normal de decir "no cargué nada".
 */
export function manualDepositsByChannel(
  deposits: Pick<Deposit, 'channel' | 'amount'>[],
): Record<DepositChannel, number> {
  const out = {} as Record<DepositChannel, number>;
  for (const channel of ALL_DEPOSIT_CHANNELS) {
    out[channel] = deposits.find((d) => d.channel === channel)?.amount || 0;
  }
  return out;
}

/**
 * «Depósitos Totales (API)» = Σ (API + manual) sobre los canales con API.
 *
 * Pura y exportada para poder fijarla con tests: es EL número de la tarjeta
 * «Depósitos» y el que después alimenta Depósitos Broker y Net Deposit. El
 * canal 'other' queda afuera a propósito — es manual puro y se suma aparte al
 * total del período (así estaba antes y así sigue).
 */
export function sumApiDeposits(
  apiByChannel: Partial<Record<DepositChannel, number>>,
  manualByChannel: Partial<Record<DepositChannel, number>>,
): number {
  return API_DEPOSIT_CHANNELS.reduce(
    (sum, { channel }) =>
      sum + (apiByChannel[channel] ?? 0) + (manualByChannel[channel] ?? 0),
    0,
  );
}

/**
 * Etiqueta del canal traducida. La clave i18n es
 * `movements.channelLabel.<canal>`; si falta, cae a `CHANNEL_LABELS`
 * (castellano, que es lo que se mostraba antes de que esto se tradujera).
 */
export function depositChannelLabel(
  channel: DepositChannel,
  t: (key: string) => string,
): string {
  const key = `movements.channelLabel.${channel}`;
  const translated = t(key);
  return translated === key ? CHANNEL_LABELS[channel] ?? channel : translated;
}
