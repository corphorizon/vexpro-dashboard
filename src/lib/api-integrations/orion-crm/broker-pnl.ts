// ─────────────────────────────────────────────────────────────────────────────
// Orion CRM — Broker P&L (profit and loss) for a range + month context.
//
// Feeds the "Broker P&L" section of /finanzas/reportes. Broker P&L can be
// positive (profit) OR negative (loss) — the UI colours accordingly.
//
//   · pnl_range       — P&L accumulated inside [from, to]
//   · pnl_month       — P&L for the current calendar month (running)
//   · pnl_prev_month  — P&L for the previous calendar month (final)
//
// The month figures let the report compute the "% of month" and
// "vs previous month" comparisons without extra round-trips.
// ─────────────────────────────────────────────────────────────────────────────

import { proxiedFetch } from '../proxy';
import {
  resolveOrionCrmConfig,
  orionHeaders,
  isMockFallbackEnabled,
} from './auth';

const ENDPOINT_PNL = '/v1/broker-pnl'; // POST { from, to }

export interface OrionCrmBrokerPnl {
  pnl_range: number;
  pnl_month: number;
  pnl_prev_month: number;
  connected: boolean;
  isMock: boolean;
  errorMessage: string | null;
}

const EMPTY: OrionCrmBrokerPnl = {
  pnl_range: 0,
  pnl_month: 0,
  pnl_prev_month: 0,
  connected: false,
  isMock: false,
  errorMessage: null,
};

function mockPnl(from: string, to: string): OrionCrmBrokerPnl {
  const seed = parseInt(from.replace(/-/g, '').slice(0, 8), 10) || 20260401;
  const daysInRange = Math.max(
    1,
    Math.round(
      (new Date(to).getTime() - new Date(from).getTime()) / (1000 * 60 * 60 * 24),
    ) + 1,
  );
  // Oscillate between positive and negative — realistic broker P&L.
  const sign = seed % 3 === 0 ? -1 : 1;
  return {
    pnl_range: sign * Math.round((seed % 4103) * 1.7 * daysInRange),
    pnl_month: Math.round((seed % 17) - 8) * 1000 + Math.round((seed % 9871)),
    pnl_prev_month: Math.round((seed % 13) - 6) * 1000 + Math.round((seed % 7543)),
    connected: false,
    isMock: true,
    errorMessage: null,
  };
}

export async function fetchOrionCrmBrokerPnl(
  companyId: string | null | undefined,
  from: string,
  to: string,
): Promise<OrionCrmBrokerPnl> {
  const config = await resolveOrionCrmConfig(companyId ?? null);

  if (!config) {
    return isMockFallbackEnabled() ? mockPnl(from, to) : EMPTY;
  }

  try {
    const res = await proxiedFetch(`${config.baseUrl}${ENDPOINT_PNL}`, {
      method: 'POST',
      headers: orionHeaders(config),
      body: JSON.stringify({ from, to }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      console.warn(`[orion-crm/broker-pnl] ${res.status} ${res.statusText}`);
      return isMockFallbackEnabled()
        ? mockPnl(from, to)
        : { ...EMPTY, errorMessage: `HTTP ${res.status}` };
    }

    const json = (await res.json()) as Partial<OrionCrmBrokerPnl>;
    return {
      pnl_range: Number(json.pnl_range) || 0,
      pnl_month: Number(json.pnl_month) || 0,
      pnl_prev_month: Number(json.pnl_prev_month) || 0,
      connected: true,
      isMock: false,
      errorMessage: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.warn('[orion-crm/broker-pnl] fetch failed:', msg);
    return isMockFallbackEnabled()
      ? mockPnl(from, to)
      : { ...EMPTY, errorMessage: msg };
  }
}
