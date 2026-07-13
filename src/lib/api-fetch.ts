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

// ─────────────────────────────────────────────────────────────────────────────
// apiFetch — wrapper canónico para llamar la API interna desde el cliente
// (ARQ-02). Centraliza tres cosas que antes cada componente reimplementaba:
//   1. withActiveCompany (scope de superadmin viewing-as) — automático.
//   2. Timeout (AbortController) — evita requests colgados para siempre.
//   3. Content-Type: application/json — SOLO cuando el body es string; los
//      bodies FormData/Blob se dejan intactos (el browser pone el boundary).
//
// Devuelve un `Response` normal (misma interfaz que fetch), así el manejo de
// res.ok / res.json() / errores en cada call-site queda IGUAL — la migración
// es un swap mecánico `fetch(withActiveCompany(url), opts)` → `apiFetch(url, opts)`.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 25_000;

export async function apiFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;

  const headers = new Headers(rest.headers);
  if (typeof rest.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  // Timeout propio salvo que el caller ya haya pasado su signal.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let signal = rest.signal;
  if (!signal) {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    signal = controller.signal;
  }

  try {
    return await fetch(withActiveCompany(url), { ...rest, headers, signal });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
