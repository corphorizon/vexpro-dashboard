// ─────────────────────────────────────────────────────────────────────────────
// Orion CRM — Client-side React hook for totals.
//
// Consumes `/api/integrations/orion-crm/totals?from=&to=`, which internally
// calls the server-side `fetchOrionCrmTotals()` (see totals.ts). Mirrors
// the old `useBrokerCrmTotals` shape so existing callers keep working
// with a minimal rename.
//
// The hook is the ONLY file in this folder that's marked `'use client'`
// — the rest must stay server-safe so API routes and crons can import
// them freely.
// ─────────────────────────────────────────────────────────────────────────────

'use client';

import { useEffect, useMemo, useState } from 'react';
import type { OrionCrmTotals } from './totals';
import { withActiveCompany } from '@/lib/api-fetch';

const EMPTY: OrionCrmTotals = {
  propFirmSales: 0,
  p2pTransfer: 0,
  connected: false,
  isMock: false,
  lastSync: null,
  errorMessage: null,
};

/**
 * Fetches Orion CRM totals for a date range via the server-side proxy
 * endpoint. Returns zeros while loading or when `from`/`to` are missing.
 *
 * @param refreshKey bump to force a re-fetch (e.g. after a live sync).
 */
export function useOrionCrmTotals(
  from: string,
  to: string,
  refreshKey: number = 0,
): OrionCrmTotals {
  const [totals, setTotals] = useState<OrionCrmTotals>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    if (!from || !to) {
      setTotals(EMPTY);
      return;
    }
    (async () => {
      try {
        const qs = new URLSearchParams({ from, to });
        const res = await fetch(withActiveCompany(`/api/integrations/orion-crm/totals?${qs}`));
        const json = (await res.json()) as OrionCrmTotals;
        if (!cancelled) setTotals(json);
      } catch {
        if (!cancelled) setTotals(EMPTY);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [from, to, refreshKey]);

  return useMemo(() => totals, [totals]);
}

// Re-export so pages can keep a single import path.
export type { OrionCrmTotals } from './totals';
