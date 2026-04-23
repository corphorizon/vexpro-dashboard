// ─────────────────────────────────────────────────────────────────────────────
// api-fetch — client-side fetch helper that appends ?company_id when the
// caller is a platform superadmin in "viewing-as" mode.
//
// Backend endpoints that use `verifyAuth(request)` accept the query param
// only for superadmins — regular users resolve their company from the JWT.
// For a regular user, `getActiveCompanyId()` returns null and the URL is
// passed through unchanged.
//
// Usage:
//   import { withActiveCompany } from '@/lib/api-fetch';
//   const res = await fetch(withActiveCompany('/api/integrations/coinsbuy/wallets'));
// ─────────────────────────────────────────────────────────────────────────────

import { getActiveCompanyId } from '@/lib/active-company';

/**
 * Appends `?company_id=<id>` (or `&company_id=`) to `url` when there's an
 * active superadmin viewing-as company. Idempotent — if `company_id` is
 * already present in the URL, returns it unchanged.
 */
export function withActiveCompany(url: string): string {
  const companyId = getActiveCompanyId();
  if (!companyId) return url;
  // Don't duplicate if already present.
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    if (parsed.searchParams.has('company_id')) return url;
  } catch {
    // Malformed URL — let the server reject.
  }
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}company_id=${encodeURIComponent(companyId)}`;
}
