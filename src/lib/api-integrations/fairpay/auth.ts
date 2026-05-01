// ─────────────────────────────────────────────────────────────────────────────
// FairPay — Access Token Authentication (per-tenant)
//
// Two-step JWT flow:
//   POST /api/auth/getAccessToken with form data:  api_key=<merchant_api_key>
//   Response: { status, code, data: { scalar: "<JWT_TOKEN>" } }
//
// JWT expires in 3600 seconds (1 hour). Subsequent calls use:
//   Authorization: Bearer <token>
//
// IMPORTANT: Force IPv4 in case FairPay's host blocks IPv6 (consistent with
// UniPayment fix). Sandbox host: sandbox-portal.fairpay.online
//
// MULTI-TENANT: every exported function accepts an optional `companyId`.
// Resolution order per-tenant:
//   1. api_credentials row for (company_id, 'fairpay') — per-tenant.
//   2. FAIRPAY_API_KEY env — global fallback.
//
// Tokens cached per-tenant (Map keyed by companyId, '__env__' for env path).
// ─────────────────────────────────────────────────────────────────────────────

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { resolveFairpayCredentials } from '../credentials';

// Production: https://portal.fairpay.online
// Sandbox:    https://sandbox-portal.fairpay.online
const ENV_BASE_URL =
  process.env.FAIRPAY_BASE_URL ?? 'https://portal.fairpay.online';

// Token TTL in seconds. The JWT issued by FairPay lasts 1 hour, but we cache
// for 50 minutes to leave a safety margin.
const TOKEN_TTL_MS = 50 * 60 * 1000;

const ENV_KEY = '__env__';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
}

async function resolveConfig(companyId: string | null | undefined): Promise<ResolvedConfig | null> {
  // Env fallback removed 2026-05-01 — tenants without per-tenant
  // api_credentials get an empty error dataset instead of someone else's
  // FairPay data. See coinsbuy/auth.ts for the full rationale.
  if (!companyId) return null;
  const perTenant = await resolveFairpayCredentials(companyId);
  if (!perTenant) return null;
  return {
    apiKey: perTenant.apiKey,
    baseUrl: perTenant.baseUrl ?? ENV_BASE_URL,
  };
}

/**
 * True when FairPay is configured for the given tenant (per-tenant row OR
 * env fallback). Async because the DB lookup is per-tenant.
 */
export async function isFairpayEnabled(
  companyId?: string | null,
): Promise<boolean> {
  const config = await resolveConfig(companyId ?? null);
  return !!config;
}

/**
 * Returns the FairPay base URL for a tenant (per-tenant override or env).
 */
export async function getFairpayBaseUrl(
  companyId?: string | null,
): Promise<string> {
  const config = await resolveConfig(companyId ?? null);
  return config?.baseUrl ?? ENV_BASE_URL;
}

/**
 * Fetches (or returns a cached) FairPay access token for the given tenant.
 *
 * Tokens cached per-tenant. TTL is 50min even though JWT is 60min — 10min
 * safety margin prevents edge-case expirations mid-request.
 */
export async function getFairpayToken(
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
        ? 'FairPay no está configurado para esta empresa ni hay credenciales globales.'
        : 'Missing FAIRPAY_API_KEY environment variable',
    );
  }

  const body = new URLSearchParams({ api_key: config.apiKey });

  const response = await fetch(`${config.baseUrl}/api/auth/getAccessToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(
      `FairPay token request failed: ${response.status} ${response.statusText} — ${errorBody.slice(0, 200)}`,
    );
  }

  const json = (await response.json()) as {
    status: boolean;
    code: number;
    data?: { scalar?: string };
  };

  if (!json.status || !json.data?.scalar) {
    throw new Error(
      `FairPay token response invalid: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }

  const fresh: CachedToken = {
    accessToken: json.data.scalar,
    expiresAt: now + TOKEN_TTL_MS,
  };
  tokenCache.set(key, fresh);
  return fresh.accessToken;
}
