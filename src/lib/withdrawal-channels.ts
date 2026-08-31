// ─────────────────────────────────────────────────────────────────────────────
// Canales de RETIRO — registro único (canal ↔ proveedor ↔ status de salida).
//
// POR QUÉ EXISTE ESTE ARCHIVO (2026-08-31)
// Es el simétrico exacto de `deposit-channels.ts`, y nace del mismo pedido de
// Kevin, un día después: «de paypros en movimientos incluí también los retiros
// por ese medio».
//
// El lado de los DEPÓSITOS ya tenía registro único desde el 2026-08-31 por la
// razón escrita en `deposit-channels.ts`: el par canal↔slug estaba cableado
// cuatro veces y las cuatro decían "tres canales". El lado de los RETIROS tenía
// el mismo problema con menos ruido, porque durante meses hubo un solo canal:
//
//   · `loadPersistedTotals` (server, api-integrations/persistence.ts) sumaba
//     `by['coinsbuy-withdrawals'] + payprosPayouts` — es decir, YA contaba los
//     retiros de Pay-Pros.
//   · `useApiTotals` (cliente, realtime-movements-banner.tsx) devolvía
//     `withdrawalsTotal = by['coinsbuy-withdrawals']`, a secas.
//
// Dos verdades para el mismo número, otra vez, y con el signo peor: el que
// faltaba era del lado de la PANTALLA, que es la que mira una persona. Mientras
// no hubo ninguna fila 'payout_paid' la divergencia era invisible; el día que
// entrara la primera, /movimientos habría mostrado un Net Deposit inflado sin
// que nada fallara. Es el modo de falla número uno del repo
// (docs/reglas-del-proyecto.md §1.1) combinado con el §1.2.
//
// Si mañana entra otro proveedor con retiros, se agrega ACÁ y las dos puntas lo
// heredan. Nunca una segunda lista.
//
// CLIENT-SAFE a propósito: no importa Supabase ni nada de servidor.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProviderSlug } from './api-integrations/types';
import { ACCEPTED_STATUS, PAYPROS_PAYOUT_STATUS } from './api-integrations/totals';

/** Clave del canal de retiro. No hay tabla de carga manual por canal (todavía). */
export type WithdrawalChannel = 'coinsbuy' | 'paypros';

export interface ApiWithdrawalChannel {
  key: WithdrawalChannel;
  /** Slug del proveedor en `api_transactions.provider`. */
  slug: ProviderSlug;
  /**
   * Status que significa "la plata salió". En Coinsbuy el provider ya es de
   * retiros y el status confirma; en Pay-Pros el provider es UNO SOLO para los
   * dos sentidos y el status es lo ÚNICO que los distingue ('paid' entra,
   * 'payout_paid' sale). Por eso el registro guarda el status y no solo el slug:
   * con el slug alcanzaba para Coinsbuy y se rompía en Pay-Pros.
   *
   * Los valores NO se escriben acá: salen de `api-integrations/totals.ts`, que
   * es donde ya vivían. Copiarlos habría creado la tercera lista del mismo
   * dato, que es exactamente el problema que este archivo vino a resolver.
   */
  status: string;
}

export const API_WITHDRAWAL_CHANNELS: readonly ApiWithdrawalChannel[] = [
  {
    key: 'coinsbuy',
    slug: 'coinsbuy-withdrawals',
    status: ACCEPTED_STATUS['coinsbuy-withdrawals'],
  },
  { key: 'paypros', slug: 'paypros', status: PAYPROS_PAYOUT_STATUS },
] as const;

/**
 * Importe de retiros por canal. `null` = NO LO SABEMOS (el dataset del
 * proveedor todavía no llegó); `0` = sabemos que no hubo retiros.
 *
 * La distinción no es cosmética: la pantalla muestra «sin datos» en el primer
 * caso y «$0,00» en el segundo, y sumar un `null` como 0 al total daría un
 * número menor que el real sin ningún aviso (§1.2 y §1.3 de las reglas).
 */
export type WithdrawalsByChannel = Partial<Record<WithdrawalChannel, number | null>>;

/**
 * «Retiros Totales (API)» = Σ de los canales con dato.
 *
 * Pura y exportada para poder fijarla con tests: alimenta Retiros Totales y,
 * por `computeDerivedNetDeposit`, el Net Deposit que consume la cadena de
 * distribución. Los canales sin dato NO se cuentan como cero — se informan
 * aparte con `channelsWithoutData`, porque una exclusión silenciosa es
 * indistinguible de un cruce roto.
 */
export function sumApiWithdrawals(byChannel: WithdrawalsByChannel): {
  total: number;
  channelsWithoutData: WithdrawalChannel[];
} {
  let total = 0;
  const channelsWithoutData: WithdrawalChannel[] = [];
  for (const { key } of API_WITHDRAWAL_CHANNELS) {
    const value = byChannel[key];
    if (value === null || value === undefined || !Number.isFinite(value)) {
      channelsWithoutData.push(key);
      continue;
    }
    total += value;
  }
  return { total, channelsWithoutData };
}

/**
 * Etiqueta del canal traducida. La clave i18n es
 * `movements.channelLabel.<canal>`, la MISMA que usan los depósitos: el canal
 * se llama igual entre y sale plata, y dos claves para el mismo nombre es cómo
 * se termina con «Pay-Pros» de un lado y «PayPros» del otro.
 */
export function withdrawalChannelLabel(
  channel: WithdrawalChannel,
  t: (key: string) => string,
): string {
  const key = `movements.channelLabel.${channel}`;
  const translated = t(key);
  return translated === key ? channel : translated;
}
