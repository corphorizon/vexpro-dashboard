// ─────────────────────────────────────────────────────────────────────────────
// FairPay — Access Token Authentication
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
// ─────────────────────────────────────────────────────────────────────────────

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

// Production: https://portal.fairpay.online
// Sandbox:    https://sandbox-portal.fairpay.online
const FAIRPAY_BASE_URL =
  process.env.FAIRPAY_BASE_URL ?? 'https://portal.fairpay.online';

// Token TTL in seconds. The JWT issued by FairPay lasts 1 hour, but we cache
// for 50 minutes to leave a safety margin.
const TOKEN_TTL_MS = 50 * 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/**
 * Returns true when the FairPay integration is configured (not mocked).
 */
export function isFairpayEnabled(): boolean {
  const apiKey = process.env.FAIRPAY_API_KEY;
  return !!apiKey && apiKey !== 'mock';
}

/**
 * Returns the FairPay base URL (sandbox or production from env).
 */
export function getFairpayBaseUrl(): string {
  return FAIRPAY_BASE_URL;
}

/**
 * Fetches (or returns a cached) FairPay access token.
 *
 * The token is kept in memory and renewed automatically when within 60s of
 * expiration.
 */
export async function getFairpayToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && cachedToken.expiresAt - now > 60_000) {
    return cachedToken.accessToken;
  }

  const apiKey = process.env.FAIRPAY_API_KEY;
  if (!apiKey) {
    throw new Error('Missing FAIRPAY_API_KEY environment variable');
  }

  const body = new URLSearchParams({ api_key: apiKey });

  const response = await fetch(`${FAIRPAY_BASE_URL}/api/auth/getAccessToken`, {
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

  cachedToken = {
    accessToken: json.data.scalar,
    expiresAt: now + TOKEN_TTL_MS,
  };

  return cachedToken.accessToken;
}
