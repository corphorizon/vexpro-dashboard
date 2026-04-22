// ─────────────────────────────────────────────────────────────────────────────
// Orion CRM — Aggregated totals for a date range
//
// This is the unified successor to the old broker-crm.ts stub. Same
// contract (prop firm sales + P2P transfer for a range) but:
//   · Reads per-tenant credentials from api_credentials via auth.ts
//   · Serves realistic mock data when no credentials exist and the
//     fallback is enabled — so the Movimientos page can sum an API-side
//     contribution > 0 during dev/demo
//   · Real HTTP call is implemented below but the endpoint is still a
//     placeholder until Orion publishes one. When they do, only the URL
//     path in `ENDPOINT_TOTALS` changes.
//
// The `useOrionCrmTotals` hook lives in `./client.ts` (client-side only)
// so this file stays server-safe and importable from /api routes + crons.
// ─────────────────────────────────────────────────────────────────────────────

import { proxiedFetch } from '../proxy';
import {
  resolveOrionCrmConfig,
  orionHeaders,
  isMockFallbackEnabled,
} from './auth';

const ENDPOINT_TOTALS = '/v1/totals'; // POST with { from, to }

export interface OrionCrmTotals {
  /** Prop firm sales pulled from the CRM for the requested range. */
  propFirmSales: number;
  /** P2P transfers (withdrawals side) reported by the CRM for the range. */
  p2pTransfer: number;
  /** True if the response came from the real CRM API. */
  connected: boolean;
  /** True when the values are from the mock fallback (not real data). */
  isMock: boolean;
  /** ISO timestamp of the last successful sync, or null if never. */
  lastSync: string | null;
  /** Human-readable error when connected=false AND no mock fallback served. */
  errorMessage: string | null;
}

const EMPTY_TOTALS: OrionCrmTotals = {
  propFirmSales: 0,
  p2pTransfer: 0,
  connected: false,
  isMock: false,
  lastSync: null,
  errorMessage: null,
};

// Deterministic-ish mock values so dev sessions don't see wildly different
// numbers on every refresh. Seeded by the `from` date so scrolling through
// months shows a consistent progression.
function mockTotals(from: string, to: string): OrionCrmTotals {
  const seed = parseInt(from.replace(/-/g, '').slice(0, 8), 10) || 20260401;
  const daysInRange = Math.max(
    1,
    Math.round(
      (new Date(to).getTime() - new Date(from).getTime()) / (1000 * 60 * 60 * 24),
    ) + 1,
  );
  return {
    propFirmSales: Math.round((seed % 997) * 11.3 * daysInRange) / 1,
    p2pTransfer: Math.round((seed % 557) * 7.1 * daysInRange) / 1,
    connected: false,
    isMock: true,
    lastSync: new Date().toISOString(),
    errorMessage: null,
  };
}

/**
 * Fetches aggregated totals for a given tenant + date range.
 *
 * Resolution:
 *   1. If creds exist → real HTTP call to Orion CRM.
 *   2. Real call fails → log + fall back to mock if enabled, else empty.
 *   3. No creds → mock if enabled, else empty.
 */
export async function fetchOrionCrmTotals(
  companyId: string | null | undefined,
  from: string,
  to: string,
): Promise<OrionCrmTotals> {
  const config = await resolveOrionCrmConfig(companyId ?? null);

  if (!config) {
    // No credentials — mock or empty.
    return isMockFallbackEnabled() ? mockTotals(from, to) : EMPTY_TOTALS;
  }

  try {
    const res = await proxiedFetch(`${config.baseUrl}${ENDPOINT_TOTALS}`, {
      method: 'POST',
      headers: orionHeaders(config),
      body: JSON.stringify({ from, to }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(
        `[orion-crm/totals] ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
      );
      return isMockFallbackEnabled()
        ? mockTotals(from, to)
        : { ...EMPTY_TOTALS, errorMessage: `HTTP ${res.status}` };
    }

    const json = (await res.json()) as {
      totals?: { propFirmSales?: number; p2pTransfer?: number };
      lastSync?: string;
    };

    return {
      propFirmSales: Number(json.totals?.propFirmSales) || 0,
      p2pTransfer: Number(json.totals?.p2pTransfer) || 0,
      connected: true,
      isMock: false,
      lastSync: json.lastSync ?? new Date().toISOString(),
      errorMessage: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.warn('[orion-crm/totals] fetch failed:', msg);
    return isMockFallbackEnabled()
      ? mockTotals(from, to)
      : { ...EMPTY_TOTALS, errorMessage: msg };
  }
}
