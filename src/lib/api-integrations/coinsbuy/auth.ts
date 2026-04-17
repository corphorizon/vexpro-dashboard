// ─────────────────────────────────────────────────────────────────────────────
// Coinsbuy v3 — OAuth 2.0 Authentication
//
// POST /token/ with JSON:API format:
//   { data: { type: "auth-token", attributes: { client_id, client_secret } } }
//
// Response: { data: { attributes: { access, expires_in, token_type } } }
//
// All Coinsbuy API calls go through the Fixie SOCKS5 proxy when FIXIE_URL is
// set — required because Coinsbuy whitelists source IPs. When unset (local
// dev), requests go direct.
// ─────────────────────────────────────────────────────────────────────────────

import { proxiedFetch } from '../proxy';

const COINSBUY_BASE_URL =
  process.env.COINSBUY_BASE_URL ?? 'https://v3.api.coinsbuy.com';

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

let cachedToken: CachedToken | null = null;

/**
 * Returns true when the Coinsbuy v3 integration is configured and not mocked.
 */
export function isCoinsbuyV3Enabled(): boolean {
  const clientId = process.env.COINSBUY_CLIENT_ID;
  return !!clientId && clientId !== 'mock';
}

/**
 * Fetches (or returns a cached) Coinsbuy v3 OAuth 2.0 Bearer token.
 *
 * The token is kept in memory and automatically renewed when it is
 * within 60 seconds of expiration.
 */
export async function getCoinsbuyToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && cachedToken.expiresAt - now > 60_000) {
    return cachedToken.accessToken;
  }

  const clientId = process.env.COINSBUY_CLIENT_ID;
  const clientSecret = process.env.COINSBUY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing COINSBUY_CLIENT_ID or COINSBUY_CLIENT_SECRET environment variables',
    );
  }

  const response = await proxiedFetch(`${COINSBUY_BASE_URL}/token/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'auth-token',
        attributes: {
          client_id: clientId,
          client_secret: clientSecret,
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

  cachedToken = {
    accessToken: data.data.attributes.access,
    expiresAt: now + data.data.attributes.expires_in * 1000,
  };

  return cachedToken.accessToken;
}
