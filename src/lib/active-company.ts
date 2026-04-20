// ─────────────────────────────────────────────────────────────────────────────
// active-company — helpers for the superadmin's current "viewing-as" context.
//
// When a superadmin navigates into a specific company from /superadmin, we
// need to remember which company they're inspecting across page reloads and
// tab switches. localStorage is enough: this value is NOT security-sensitive
// (RLS still enforces everything server-side — a superadmin can read any
// company regardless of what's in localStorage).
//
// Regular users never call these functions; their company is derived from
// their `company_users` membership.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'horizon.superadmin.activeCompanyId';

/** True in the browser, false during SSR. */
const isClient = () => typeof window !== 'undefined' && typeof localStorage !== 'undefined';

export function getActiveCompanyId(): string | null {
  if (!isClient()) return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setActiveCompanyId(companyId: string | null): void {
  if (!isClient()) return;
  try {
    if (companyId) {
      localStorage.setItem(STORAGE_KEY, companyId);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
    // Broadcast so other tabs pick it up immediately.
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: companyId }));
  } catch {
    // Silent: private mode can disallow writes.
  }
}

export function clearActiveCompanyId(): void {
  setActiveCompanyId(null);
}

/**
 * React-friendly subscriber for places that need to re-render when the
 * active company changes (e.g. `ViewingAsBanner`). Returns an unsubscribe fn.
 */
export function subscribeActiveCompanyId(listener: (next: string | null) => void): () => void {
  if (!isClient()) return () => undefined;
  const handler = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    listener(e.newValue);
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
