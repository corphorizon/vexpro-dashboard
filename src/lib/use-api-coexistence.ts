'use client';

import { useMemo } from 'react';
import { useApiTotals, DEFAULT_WALLET_ID } from '@/components/realtime-movements-banner';
import { allPeriodsUseDerivedBroker, computeDerivedBroker } from '@/lib/broker-logic';
import type { Period } from '@/lib/types';

// ─────────────────────────────────────────────────────────────────────────────
// useApiCoexistence — the single source of truth for "manual + API" display
// values across /movimientos and /resumen-general.
//
// Rules implemented here (same as prior inline code in both pages):
//   - `useDerivedBroker` flips ON only when EVERY active period is Abr-2026+.
//     Historical consolidations fall back to stored values untouched.
//   - `apiFrom / apiTo` = first day of earliest active period → last day of
//     latest active period (used as the date range for API reads).
//   - Per-channel display  = apiValue + manualValue (both coexist, always).
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
  /** ISO date range (empty strings when `useDerivedBroker` is false). */
  apiFrom: string;
  apiTo: string;
  /** API-only per-channel amounts (0 for historical periods). */
  apiCoinsbuy: number;
  apiFairpay: number;
  apiUnipayment: number;
  /** Coinsbuy withdrawals reported by the API (0 for historical). */
  apiWithdrawalsTotal: number;
  /** Sum of all API deposit channels (useful for the "Depósitos Totales (API)" row). */
  apiDepositsTotal: (manualCoinsbuy: number, manualFairpay: number, manualUnipayment: number) => number;
  /** The `api_transactions`-backed totals keyed by provider slug. */
  apiTotalsBy: Record<'coinsbuy-deposits' | 'coinsbuy-withdrawals' | 'fairpay' | 'unipayment', number>;
  /** Derived broker withdrawal from the API side only (pre-manual-add). */
  derivedBrokerFromApi: (ibCommissions: number, propFirmWithdrawal: number, otherWithdrawal: number) => number;
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

  const apiCoinsbuy = useDerivedBroker ? apiTotals.by['coinsbuy-deposits'] ?? 0 : 0;
  const apiFairpay = useDerivedBroker ? apiTotals.by['fairpay'] ?? 0 : 0;
  const apiUnipayment = useDerivedBroker ? apiTotals.by['unipayment'] ?? 0 : 0;
  const apiWithdrawalsTotal = useDerivedBroker ? apiTotals.withdrawalsTotal : 0;

  // Helpers exposed as functions (not precomputed values) because the caller
  // supplies the manual portions — this keeps the hook decoupled from the
  // data-context's summary shape.
  const apiDepositsTotal = (m1: number, m2: number, m3: number) =>
    (apiCoinsbuy + m1) + (apiFairpay + m2) + (apiUnipayment + m3);

  const derivedBrokerFromApi = (ib: number, pf: number, other: number) =>
    useDerivedBroker
      ? computeDerivedBroker({
          apiWithdrawalsTotal,
          ibCommissions: ib,
          propFirm: pf,
          other,
        })
      : 0;

  return {
    useDerivedBroker,
    apiFrom,
    apiTo,
    apiCoinsbuy,
    apiFairpay,
    apiUnipayment,
    apiWithdrawalsTotal,
    apiDepositsTotal,
    apiTotalsBy: apiTotals.by,
    derivedBrokerFromApi,
  };
}
