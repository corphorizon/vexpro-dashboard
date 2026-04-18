// ─────────────────────────────────────────────────────────────────────────────
// Broker CRM integration — Prop Firm sales + P2P transfers
//
// STATUS: Stub / preparation layer. The endpoint does not exist yet; this
// module returns zeros so the UI can already coexist-and-sum manual + API
// values. When the real CRM endpoint is ready, implement the fetch inside
// `fetchBrokerCrmTotals` and the UI will pick it up automatically.
//
// Coexistence rule (matches Coinsbuy/FairPay/Unipayment behavior):
//   displayedValue = apiValue + manualValue
//
// The manual entry typed in Carga de Datos is NEVER overwritten — the API
// value is added on top of it.
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import { useEffect, useMemo, useState } from 'react';

export interface BrokerCrmTotals {
  /** Prop firm sales pulled from the broker CRM for the requested date range. */
  propFirmSales: number;
  /** P2P transfers (withdrawals side) reported by the CRM. */
  p2pTransfer: number;
  /** Whether the integration is configured and returned a real response. */
  connected: boolean;
  /** ISO timestamp of the last successful sync, or null if never. */
  lastSync: string | null;
  /** Human-readable error message when connected=false but creds were present. */
  errorMessage: string | null;
}

const EMPTY_TOTALS: BrokerCrmTotals = {
  propFirmSales: 0,
  p2pTransfer: 0,
  connected: false,
  lastSync: null,
  errorMessage: null,
};

/**
 * Fetch aggregated broker-CRM totals for a date range.
 *
 * TODO(backend): Implement the real HTTP call once the CRM exposes the
 * endpoint. Expected contract:
 *   GET /api/integrations/broker-crm/totals?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   → { success: true, totals: { propFirmSales: number, p2pTransfer: number },
 *       lastSync: ISO }
 *
 * Until then this resolves to zeros so the UI treats the API contribution as
 * "nothing yet" and only shows the manual value. No mocks — returning zeros
 * is the honest representation of "not connected".
 */
export async function fetchBrokerCrmTotals(
  _from: string,
  _to: string,
): Promise<BrokerCrmTotals> {
  // When the real endpoint lands, replace the body with something like:
  //
  //   const qs = new URLSearchParams({ from, to });
  //   const res = await fetch(`/api/integrations/broker-crm/totals?${qs}`);
  //   const json = await res.json();
  //   if (!json.success) {
  //     return { ...EMPTY_TOTALS, errorMessage: json.error ?? 'CRM error' };
  //   }
  //   return {
  //     propFirmSales: Number(json.totals.propFirmSales) || 0,
  //     p2pTransfer:   Number(json.totals.p2pTransfer)   || 0,
  //     connected: true,
  //     lastSync: json.lastSync ?? new Date().toISOString(),
  //     errorMessage: null,
  //   };
  return EMPTY_TOTALS;
}

/**
 * React hook that exposes broker-CRM totals for a given date range.
 *
 * Shape mirrors `useApiTotals` so the Movimientos page can consume both in
 * the same way. Currently returns zeros (not connected); will start surfacing
 * real numbers the moment `fetchBrokerCrmTotals` is implemented.
 */
export function useBrokerCrmTotals(
  from: string,
  to: string,
  refreshKey: number = 0,
): BrokerCrmTotals {
  const [totals, setTotals] = useState<BrokerCrmTotals>(EMPTY_TOTALS);

  useEffect(() => {
    let cancelled = false;
    if (!from || !to) {
      setTotals(EMPTY_TOTALS);
      return;
    }
    (async () => {
      try {
        const next = await fetchBrokerCrmTotals(from, to);
        if (!cancelled) setTotals(next);
      } catch {
        if (!cancelled) setTotals(EMPTY_TOTALS);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [from, to, refreshKey]);

  return useMemo(() => totals, [totals]);
}
