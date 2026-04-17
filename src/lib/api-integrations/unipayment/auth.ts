// ─────────────────────────────────────────────────────────────────────────────
// UniPayment — OAuth 2.0 Authentication
//
// POST /connect/token with application/x-www-form-urlencoded:
//   grant_type=client_credentials&client_id=X&client_secret=Y
//
// Response: { access_token, expires_in, token_type: "Bearer", scope }
//
// IMPORTANT: Force IPv4 for all DNS lookups. UniPayment's CDN (Cloudflare)
// blocks IPv6 connections with a 403. This global setting ensures Node.js
// resolves hostnames to IPv4 addresses first.
// ─────────────────────────────────────────────────────────────────────────────

import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { proxiedFetch } from '../proxy';

const UNIPAYMENT_BASE_URL =
  process.env.UNIPAYMENT_BASE_URL ?? 'https://api.unipayment.io';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/**
 * Returns true when the UniPayment integration is configured and not mocked.
 */
export function isUnipaymentEnabled(): boolean {
  const clientId = process.env.UNIPAYMENT_CLIENT_ID;
  return !!clientId && clientId !== 'mock';
}

/**
 * Fetches (or returns a cached) UniPayment OAuth 2.0 Bearer token.
 *
 * The token is kept in memory and automatically renewed when it is
 * within 60 seconds of expiration.
 */
export async function getUnipaymentToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && cachedToken.expiresAt - now > 60_000) {
    return cachedToken.accessToken;
  }

  const clientId = process.env.UNIPAYMENT_CLIENT_ID;
  const clientSecret = process.env.UNIPAYMENT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing UNIPAYMENT_CLIENT_ID or UNIPAYMENT_CLIENT_SECRET environment variables',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await proxiedFetch(`${UNIPAYMENT_BASE_URL}/connect/token`, {
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

  const data = await response.json() as {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
  };

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  return cachedToken.accessToken;
}
