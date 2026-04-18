// ─────────────────────────────────────────────────────────────────────────────
// useRunningBalance — compute a date-sorted running balance for any list
// of movements that have an `id` and a date. Used by /liquidez, /inversiones,
// and /balances to avoid trusting the persisted `balance` column (which was
// inserted as 0 by legacy code paths).
//
// Returns a Map<id, balance> so callers can look up the running total for
// any row without resorting the list twice.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';

interface HasIdDate {
  id: string;
  date: string;
}

export function useRunningBalance<T extends HasIdDate>(
  items: T[],
  /** Per-item delta: `deposit − withdrawal (+ profit)`. Positive adds, negative subtracts. */
  delta: (item: T) => number,
): Map<string, number> {
  return useMemo(() => {
    const map = new Map<string, number>();
    // Stable ascending-date sort; same-day rows keep insertion order.
    const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    for (const item of sorted) {
      running += delta(item);
      map.set(item.id, running);
    }
    return map;
    // We intentionally depend on `items` identity + the delta function
    // reference. Callers should pass a stable delta (inline arrows are OK
    // because the memo already keys on `items`, not on the fn identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
}
