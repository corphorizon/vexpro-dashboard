// ─────────────────────────────────────────────────────────────────────────────
// Orion CRM — Users registered in the broker platform.
//
// Feeds the "Usuarios CRM" section of /finanzas/reportes. Returns three
// counts for a given date range + month context:
//
//   · new_users_in_range       — signed up inside [from, to]
//   · new_users_this_month     — signed up inside the current calendar month
//   · total_users              — platform-wide headcount right now
//
// Mock fallback serves realistic-looking growth numbers seeded by the
// range's start date so successive demos don't whip back and forth.
// ─────────────────────────────────────────────────────────────────────────────

import { proxiedFetch } from '../proxy';
import {
  resolveOrionCrmConfig,
  orionHeaders,
  isMockFallbackEnabled,
} from './auth';

const ENDPOINT_USERS = '/v1/users/summary'; // POST { from, to }

export interface OrionCrmUsersSummary {
  new_users_in_range: number;
  new_users_this_month: number;
  total_users: number;
  connected: boolean;
  isMock: boolean;
  errorMessage: string | null;
}

const EMPTY: OrionCrmUsersSummary = {
  new_users_in_range: 0,
  new_users_this_month: 0,
  total_users: 0,
  connected: false,
  isMock: false,
  errorMessage: null,
};

function mockUsers(from: string, to: string): OrionCrmUsersSummary {
  const seed = parseInt(from.replace(/-/g, '').slice(0, 8), 10) || 20260401;
  const daysInRange = Math.max(
    1,
    Math.round(
      (new Date(to).getTime() - new Date(from).getTime()) / (1000 * 60 * 60 * 24),
    ) + 1,
  );
  // Growth-ish: ~3-8 new signups per day, monthly ~80-200, total ~2k-5k.
  const dailyRate = 3 + (seed % 6);
  return {
    new_users_in_range: dailyRate * daysInRange,
    new_users_this_month: 80 + (seed % 120),
    total_users: 2000 + (seed % 3000),
    connected: false,
    isMock: true,
    errorMessage: null,
  };
}

export async function fetchOrionCrmUsers(
  companyId: string | null | undefined,
  from: string,
  to: string,
): Promise<OrionCrmUsersSummary> {
  const config = await resolveOrionCrmConfig(companyId ?? null);

  if (!config) {
    return isMockFallbackEnabled() ? mockUsers(from, to) : EMPTY;
  }

  try {
    const res = await proxiedFetch(`${config.baseUrl}${ENDPOINT_USERS}`, {
      method: 'POST',
      headers: orionHeaders(config),
      body: JSON.stringify({ from, to }),
      signal: AbortSignal.timeout(12_000),
    });

    if (!res.ok) {
      console.warn(`[orion-crm/users] ${res.status} ${res.statusText}`);
      return isMockFallbackEnabled()
        ? mockUsers(from, to)
        : { ...EMPTY, errorMessage: `HTTP ${res.status}` };
    }

    const json = (await res.json()) as Partial<OrionCrmUsersSummary>;
    return {
      new_users_in_range: Number(json.new_users_in_range) || 0,
      new_users_this_month: Number(json.new_users_this_month) || 0,
      total_users: Number(json.total_users) || 0,
      connected: true,
      isMock: false,
      errorMessage: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.warn('[orion-crm/users] fetch failed:', msg);
    return isMockFallbackEnabled()
      ? mockUsers(from, to)
      : { ...EMPTY, errorMessage: msg };
  }
}
