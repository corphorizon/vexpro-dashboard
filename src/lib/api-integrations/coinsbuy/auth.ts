// ─────────────────────────────────────────────────────────────────────────────
// Coinsbuy v3 — OAuth 2.0 Authentication (per-tenant)
//
// POST /token/ with JSON:API format:
//   { data: { type: "auth-token", attributes: { client_id, client_secret } } }
//
// Response: { data: { attributes: { access, expires_in, token_type } } }
//
// All Coinsbuy API calls go through the Fixie SOCKS5 proxy when FIXIE_URL is
// set — required because Coinsbuy whitelists source IPs. When unset (local
// dev), requests go direct.
//
// MULTI-TENANT: every exported function accepts an optional `companyId`.
// Resolution order per-tenant:
//   1. api_credentials row for (company_id, 'coinsbuy') — per-tenant.
//   2. COINSBUY_CLIENT_ID / COINSBUY_CLIENT_SECRET env — global fallback.
//      Keeps VexPro FX working until the superadmin uploads per-tenant creds.
//
// Tokens are cached per-tenant (or per "__env__" key for env fallback) so
// two tenants never accidentally share a token.
// ─────────────────────────────────────────────────────────────────────────────

import { proxiedFetch } from '../proxy';
import { resolveCoinsbuyCredentials } from '../credentials';

const ENV_BASE_URL =
  process.env.COINSBUY_BASE_URL ?? 'https://v3.api.coinsbuy.com';

// Sentinel key used in the cache when running off process.env only.
// UUIDs always contain dashes, so '__env__' will never collide.
const ENV_KEY = '__env__';

interface TokenResponseData {
  data: {
    type: string;
    id: string;
    attributes: {
      access: string;
      expires_in: number;
      token_type: string;
    };
  };
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

// One cache entry per tenant — critical to avoid leaking tokens between
// companies when one is misconfigured and falls through to env while
// another has its own creds.
const tokenCache = new Map<string, CachedToken>();

interface ResolvedConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

/**
 * Loads per-tenant credentials from api_credentials.
 *
 * Returns null when the tenant has no row — caller treats that as
 * "not configured" and produces an empty error dataset.
 *
 * NOTE (2026-05-01): the env fallback was REMOVED. Investigation found that
 * the cron iterated every active company and, for tenants without their own
 * api_credentials row, fell through to env vars and pulled the same Coinsbuy
 * data into multiple `company_id`s — a cross-tenant data leak. With the
 * fallback gone, tenants that don't configure their own credentials simply
 * get empty datasets, which is the correct behaviour. A `companyId` is now
 * required; the legacy "no companyId → use env" path returns null too.
 */
async function resolveConfig(companyId: string | null | undefined): Promise<ResolvedConfig | null> {
  if (!companyId) return null;
  const perTenant = await resolveCoinsbuyCredentials(companyId);
  if (!perTenant) return null;
  return {
    clientId: perTenant.clientId,
    clientSecret: perTenant.clientSecret,
    baseUrl: perTenant.baseUrl ?? ENV_BASE_URL,
  };
}

/**
 * Returns true when Coinsbuy is configured for the given tenant (per-tenant
 * row OR env fallback) and not stubbed to 'mock'. Async because the DB
 * lookup is per-tenant.
 *
 * Callers that need to know "configured at all, regardless of tenant" can
 * pass null and the answer falls through to env.
 */
export async function isCoinsbuyV3Enabled(
  companyId?: string | null,
): Promise<boolean> {
  const config = await resolveConfig(companyId ?? null);
  return !!config;
}

/**
 * Fetches (or returns a cached) Coinsbuy v3 OAuth 2.0 Bearer token for the
 * given tenant. Tokens are cached per-tenant — never leak across companies.
 *
 * The token is kept in memory and automatically renewed when it is
 * within 60 seconds of expiration.
 */
export async function getCoinsbuyToken(
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
        ? `Coinsbuy no está configurado para esta empresa ni hay credenciales globales.`
        : 'Missing COINSBUY_CLIENT_ID or COINSBUY_CLIENT_SECRET environment variables',
    );
  }

  const response = await proxiedFetch(`${config.baseUrl}/token/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'auth-token',
        attributes: {
          client_id: config.clientId,
          client_secret: config.clientSecret,
        },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `Coinsbuy token request failed: ${response.status} ${response.statusText} — ${errorBody.slice(0, 200)}`,
    );
  }

  const data: TokenResponseData = await response.json();

  const fresh: CachedToken = {
    accessToken: data.data.attributes.access,
    expiresAt: now + data.data.attributes.expires_in * 1000,
  };
  tokenCache.set(key, fresh);
  return fresh.accessToken;
}

/**
 * Returns the resolved Coinsbuy base URL for a given tenant (per-tenant
 * override OR env default). Used by downstream helpers (wallets, deposits,
 * payouts, transfers) so per-tenant base_url overrides propagate.
 */
export async function getCoinsbuyBaseUrl(
  companyId?: string | null,
): Promise<string> {
  const config = await resolveConfig(companyId ?? null);
  return config?.baseUrl ?? ENV_BASE_URL;
}
