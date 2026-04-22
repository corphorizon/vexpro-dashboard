// ─────────────────────────────────────────────────────────────────────────────
// Orion CRM — Authentication + configuration resolver (per-tenant)
//
// Resolution order:
//   1. api_credentials row for (company_id, 'orion_crm') — per-tenant.
//   2. ORION_CRM_API_KEY / ORION_CRM_BASE_URL env — global fallback.
//   3. `null` → caller treats as "not configured" and (optionally) serves
//      mock data. Mocks let us build the Reportes UI without waiting on
//      the real CRM endpoint to exist.
//
// Orion uses a single Bearer-style API key (unlike Coinsbuy/UniPayment's
// OAuth2 client_id+client_secret dance). The key is sent as
//   Authorization: Bearer <key>
// on every request. No token refresh / expiration handling needed.
//
// No token cache: the key itself IS the bearer token. Keep this module
// small on purpose — the heavy lifting lives in users.ts / broker-pnl.ts
// / prop-trading.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveOrionCrmCredentials } from '../credentials';

const ENV_BASE_URL = process.env.ORION_CRM_BASE_URL ?? 'https://api.orion-crm.example';

/** Whether the mock-fallback path is active. Flip to false in prod when
 * you want "no credentials" to fail loudly instead of returning fake data. */
const MOCK_FALLBACK_ENABLED =
  (process.env.ORION_CRM_ENABLE_MOCK_FALLBACK ?? 'true').toLowerCase() !== 'false';

export interface OrionCrmConfig {
  apiKey: string;
  baseUrl: string;
}

/**
 * Loads per-tenant credentials, falling back to env, or null when neither
 * path is configured. Never throws.
 */
export async function resolveOrionCrmConfig(
  companyId: string | null | undefined,
): Promise<OrionCrmConfig | null> {
  if (companyId) {
    const perTenant = await resolveOrionCrmCredentials(companyId);
    if (perTenant) {
      return {
        apiKey: perTenant.apiKey,
        baseUrl: perTenant.baseUrl ?? ENV_BASE_URL,
      };
    }
  }
  const envKey = process.env.ORION_CRM_API_KEY;
  if (!envKey || envKey === 'mock') return null;
  return { apiKey: envKey, baseUrl: ENV_BASE_URL };
}

/** True when Orion CRM has real credentials for this tenant (or the env
 *  fallback). Callers use this to decide whether to skip the mock path. */
export async function isOrionCrmConfigured(
  companyId?: string | null,
): Promise<boolean> {
  return (await resolveOrionCrmConfig(companyId ?? null)) !== null;
}

/**
 * True when callers should serve realistic mock data instead of throwing
 * "not configured". Controlled by the ORION_CRM_ENABLE_MOCK_FALLBACK env
 * var; default true so local dev + the Reportes UI work end-to-end before
 * real creds exist.
 */
export function isMockFallbackEnabled(): boolean {
  return MOCK_FALLBACK_ENABLED;
}

/** Shared headers for every Orion CRM request. */
export function orionHeaders(config: OrionCrmConfig): HeadersInit {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}
