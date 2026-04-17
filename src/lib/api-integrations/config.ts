// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Configuration
//
// Reads provider credentials from environment variables. ALL providers fall
// back to mock mode when credentials are not present (no errors thrown).
//
// Required env vars (set in Vercel / .env.local — never hardcode):
//   COINSBUY_API_KEY        COINSBUY_API_SECRET        COINSBUY_BASE_URL
//   FAIRPAY_API_KEY         FAIRPAY_API_SECRET         FAIRPAY_BASE_URL
//   UNIPAYMENT_API_KEY      UNIPAYMENT_API_SECRET      UNIPAYMENT_BASE_URL
// ─────────────────────────────────────────────────────────────────────────────

import type { ProviderId, ProviderConfig } from './types';

function readConfig(prefix: string): ProviderConfig {
  // NOTE: process.env is server-side only. These integrations should be
  // called from API routes (server) — never directly from the browser.
  //
  // Coinsbuy v3 uses CLIENT_ID/CLIENT_SECRET (OAuth 2.0) instead of API_KEY/API_SECRET.
  // We check both for backward compatibility.
  const apiKey = process.env[`${prefix}_API_KEY`] ?? process.env[`${prefix}_CLIENT_ID`];
  const apiSecret = process.env[`${prefix}_API_SECRET`] ?? process.env[`${prefix}_CLIENT_SECRET`];
  const baseUrl = process.env[`${prefix}_BASE_URL`];

  return {
    enabled: !!(apiKey && apiSecret && apiKey !== 'mock'),
    credentials: { apiKey, apiSecret, baseUrl },
  };
}

export const PROVIDER_CONFIG: Record<ProviderId, ProviderConfig> = {
  coinsbuy:   readConfig('COINSBUY'),
  fairpay:    readConfig('FAIRPAY'),
  unipayment: readConfig('UNIPAYMENT'),
};

// Refresh interval for the Movimientos page (5 minutes)
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Retry configuration
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_BACKOFF_MS = 1000; // multiplied per attempt

export function isProviderEnabled(provider: ProviderId): boolean {
  return PROVIDER_CONFIG[provider]?.enabled ?? false;
}
