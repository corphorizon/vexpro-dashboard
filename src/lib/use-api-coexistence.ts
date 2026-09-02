'use client';

import { useMemo } from 'react';
import { useApiTotals, DEFAULT_WALLET_ID } from '@/components/realtime-movements-banner';
import { allPeriodsUseDerivedBroker } from '@/lib/broker-logic';
import {
  API_DEPOSIT_CHANNELS,
  manualDepositsByChannel,
  sumApiDeposits,
  type DepositChannel,
} from '@/lib/deposit-channels';
import {
  API_WITHDRAWAL_CHANNELS,
  type WithdrawalChannel,
  type WithdrawalsByChannel,
} from '@/lib/withdrawal-channels';
import type { ProviderSlug } from '@/lib/api-integrations/types';
import type { Deposit, Period } from '@/lib/types';

// ─────────────────────────────────────────────────────────────────────────────
// useApiCoexistence — the single source of truth for "manual + API" display
// values across /movimientos and /resumen-general.
//
// Rules implemented here (same as prior inline code in both pages):
//   - `useDerivedBroker` flips ON only when EVERY active period is Abr-2026+.
//     Historical consolidations fall back to stored values untouched.
//   - El rango de fechas de la lectura de API (primer día del período activo
//     más viejo → último día del más nuevo) se calcula acá adentro y ya NO se
//     devuelve: `apiFrom`/`apiTo` salían del hook, /movimientos los
//     desestructuraba y no los usaba, y monthly-chart.tsx tiene su propia copia
//     del cálculo porque necesita otro conjunto de períodos. Devolver un dato
//     que nadie consume invita a que alguien lo use creyendo que significa algo
//     más (2026-08-31, auditoría de finanzas, ítem 20).
//   - Per-channel display  = apiValue + manualValue (both coexist, always).
//     Los canales salen de `API_DEPOSIT_CHANNELS` (src/lib/deposit-channels.ts),
//     que es el registro único. Hasta el 2026-08-31 estaban cableados acá y
//     Pay-Pros —que el backend ya contaba— no llegaba a la pantalla.
//   - Broker withdrawal    = API-derived + manual stored (coexist).
//   - Deposits Broker line = apiDepositsTotal − propFirmSalesDisplay
//     (includes manual Prop Firm sales so the number reflects reality).
//
// Callers pass `activePeriods` (periods they want totals for) and receive
// everything they need to render. `walletId` is optional — defaults to the
// "Main VexPro" wallet used by the banner.
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiCoexistenceTotals {
  /** True when every active period is on the derived-broker rule (Abr-2026+). */
  useDerivedBroker: boolean;
  /**
   * Importe de API por CANAL (0 en períodos históricos). Sale del registro
   * único `API_DEPOSIT_CHANNELS`: nada de campos sueltos por canal, que es
   * como se perdió Pay-Pros.
   */
  apiByChannel: Record<DepositChannel, number>;
  /**
   * Canales apagados para esta empresa (channel_configs.is_visible=false).
   * La tabla no dibuja su fila: AP Markets no tiene "FairPay en $0", no tiene
   * FairPay. Kevin, 2026-09-02.
   */
  hiddenChannels: string[];
  /**
   * Retiros reportados por la API, sumando TODOS los canales del registro
   * `API_WITHDRAWAL_CHANNELS` (0 en períodos históricos). Hasta el 2026-08-31
   * era solo Coinsbuy y el comentario decía "Coinsbuy withdrawals": Pay-Pros
   * llegaba al servidor y no a la pantalla.
   */
  apiWithdrawalsTotal: number;
  /**
   * Retiro por canal, para poder MOSTRARLOS y no solo sumarlos. `null` = no lo
   * sabemos todavía (el dataset no llegó), que no es lo mismo que $0.
   */
  apiWithdrawalsByChannel: WithdrawalsByChannel;
  /**
   * Canales cuyo retiro no se pudo leer y por lo tanto NO están en
   * `apiWithdrawalsTotal`. Viaja hasta la UI porque una exclusión silenciosa es
   * indistinguible de un cruce roto (§1.2).
   */
  withdrawalChannelsWithoutData: WithdrawalChannel[];
  /**
   * «Depósitos Totales (API)» = Σ (API + manual) sobre los canales con API.
   * Recibe el manual POR CANAL (no posicional): con tres argumentos sueltos,
   * sumar un cuarto canal significaba tocar tres llamadas y confiar en el
   * orden.
   */
  apiDepositsTotal: (manualByChannel: Record<DepositChannel, number>) => number;
  /** The `api_transactions`-backed totals keyed by provider slug. */
  apiTotalsBy: Record<ProviderSlug, number>;
}

/** Azúcar para las páginas: manual por canal a partir de `summary.deposits`. */
export function manualDeposits(
  deposits: Pick<Deposit, 'channel' | 'amount'>[],
): Record<DepositChannel, number> {
  return manualDepositsByChannel(deposits);
}

export function useApiCoexistence(
  activePeriods: Period[],
  walletId: string = DEFAULT_WALLET_ID,
  refreshKey: number = 0,
): ApiCoexistenceTotals {
  const useDerivedBroker = useMemo(
    () => allPeriodsUseDerivedBroker(activePeriods),
    [activePeriods],
  );

  const { apiFrom, apiTo } = useMemo(() => {
    if (!useDerivedBroker || activePeriods.length === 0) {
      return { apiFrom: '', apiTo: '' };
    }
    const sorted = [...activePeriods].sort(
      (a, b) => a.year - b.year || a.month - b.month,
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const pad = (n: number) => String(n).padStart(2, '0');
    const lastDay = new Date(last.year, last.month, 0).getDate();
    return {
      apiFrom: `${first.year}-${pad(first.month)}-01`,
      apiTo: `${last.year}-${pad(last.month)}-${pad(lastDay)}`,
    };
  }, [useDerivedBroker, activePeriods]);

  const apiTotals = useApiTotals(apiFrom, apiTo, walletId, refreshKey);

  // Un valor por canal, derivado del registro único. Nadie enumera canales a
  // mano de acá para abajo.
  const apiByChannel = {} as Record<DepositChannel, number>;
  for (const { channel, slug } of API_DEPOSIT_CHANNELS) {
    apiByChannel[channel] = useDerivedBroker ? apiTotals.by[slug] ?? 0 : 0;
  }
  apiByChannel.other = 0; // 'other' es manual puro: no tiene lado API.
  const apiWithdrawalsTotal = useDerivedBroker ? apiTotals.withdrawalsTotal : 0;
  const hiddenChannels = apiTotals.hiddenChannels ?? [];

  // En un período HISTÓRICO no se consulta la API: el retiro por canal es 0
  // porque el valor que manda es el guardado, no porque falte el dato. Por eso
  // acá va 0 y no null — es la única rama donde el cero es una afirmación.
  const apiWithdrawalsByChannel: WithdrawalsByChannel = useDerivedBroker
    ? apiTotals.withdrawalsByChannel
    : Object.fromEntries(API_WITHDRAWAL_CHANNELS.map((c) => [c.key, 0]));
  const withdrawalChannelsWithoutData: WithdrawalChannel[] = useDerivedBroker
    ? apiTotals.withdrawalChannelsWithoutData
    : [];

  // Helpers exposed as functions (not precomputed values) because the caller
  // supplies the manual portions — this keeps the hook decoupled from the
  // data-context's summary shape.
  const apiDepositsTotal = (manualByChannel: Record<DepositChannel, number>) =>
    sumApiDeposits(apiByChannel, manualByChannel);

  // `derivedBrokerFromApi` se borró el 2026-08-31 (ítem 20): CERO consumidores.
  // El único lugar donde el broker derivado se calcula de verdad es /upload
  // (`derivedBrokerAmount`), que llama a `computeDerivedBroker` directo. Acá
  // quedaba una segunda puerta a la misma fórmula, sin usar — y una segunda
  // puerta a una fórmula de dinero es cómo empiezan las dos verdades.

  return {
    useDerivedBroker,
    apiByChannel,
    hiddenChannels,
    apiWithdrawalsTotal,
    apiWithdrawalsByChannel,
    withdrawalChannelsWithoutData,
    apiDepositsTotal,
    apiTotalsBy: apiTotals.by,
  };
}
