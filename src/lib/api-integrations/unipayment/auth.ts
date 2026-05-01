// ─────────────────────────────────────────────────────────────────────────────
// UniPayment — OAuth 2.0 Authentication (per-tenant)
//
// POST /connect/token with application/x-www-form-urlencoded:
//   grant_type=client_credentials&client_id=X&client_secret=Y
//
// Response: { access_token, expires_in, token_type: "Bearer", scope }
//
// IMPORTANT: Force IPv4 for all DNS lookups. UniPayment's CDN (Cloudflare)
// blocks IPv6 connections with a 403. This global setting ensures Node.js
// resolves hostnames to IPv4 addresses first.
//
// MULTI-TENANT: every exported function accepts an optional `companyId`.
// Resolution order per-tenant:
//   1. api_credentials row for (company_id, 'unipayment') — per-tenant.
//   2. UNIPAYMENT_CLIENT_ID / UNIPAYMENT_CLIENT_SECRET env — global fallback.
//
// Tokens cached per-tenant (Map keyed by companyId, '__env__' for env path).
// ─────────────────────────────────────────────────────────────────────────────

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { proxiedFetch } from '../proxy';
import { resolveUnipaymentCredentials } from '../credentials';

const ENV_BASE_URL =
  process.env.UNIPAYMENT_BASE_URL ?? 'https://api.unipayment.io';

const ENV_KEY = '__env__';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

interface ResolvedConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

async function resolveConfig(companyId: string | null | undefined): Promise<ResolvedConfig | null> {
  // Env fallback removed 2026-05-01 — tenants without per-tenant
  // api_credentials get an empty error dataset instead of someone else's
  // UniPayment data. See coinsbuy/auth.ts for the full rationale.
  if (!companyId) return null;
  const perTenant = await resolveUnipaymentCredentials(companyId);
  if (!perTenant) return null;
  return {
    clientId: perTenant.clientId,
    clientSecret: perTenant.clientSecret,
    baseUrl: perTenant.baseUrl ?? ENV_BASE_URL,
  };
}

/**
 * True when UniPayment is configured for the given tenant (per-tenant row
 * OR env fallback). Async because the DB lookup is per-tenant.
 */
export async function isUnipaymentEnabled(
  companyId?: string | null,
): Promise<boolean> {
  const config = await resolveConfig(companyId ?? null);
  return !!config;
}

/**
 * Fetches (or returns a cached) UniPayment OAuth 2.0 Bearer token for the
 * given tenant. Tokens cached per-tenant to prevent cross-tenant leaks.
 */
export async function getUnipaymentToken(
  companyId?: string | null,
): Promise<string> {
  const now = Date.now();
  const key = companyId ?? ENV_KEY;

  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - now > 60_000) {
    return cached.accessToken;
  }

  const config = await resolveConfig(companyId ?? null);
  if (!config) {
    throw new Error(
      companyId
        ? 'UniPayment no está configurado para esta empresa ni hay credenciales globales.'
        : 'Missing UNIPAYMENT_CLIENT_ID or UNIPAYMENT_CLIENT_SECRET environment variables',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await proxiedFetch(`${config.baseUrl}/connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      // Cloudflare (UniPayment's CDN) sometimes blocks requests without a
      // standard User-Agent. Use a common browser UA to pass its bot checks.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `UniPayment token request failed: ${response.status} ${response.statusText} — ${errorBody.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  };

  const fresh: CachedToken = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  tokenCache.set(key, fresh);
  return fresh.accessToken;
}

/**
 * Returns the resolved UniPayment base URL for a given tenant.
 */
export async function getUnipaymentBaseUrl(
  companyId?: string | null,
): Promise<string> {
  const config = await resolveConfig(companyId ?? null);
  return config?.baseUrl ?? ENV_BASE_URL;
}
