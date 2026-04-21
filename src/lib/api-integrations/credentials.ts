// ─────────────────────────────────────────────────────────────────────────────
// Per-tenant provider credential resolver.
//
// Before this module existed, the Coinsbuy / UniPayment / FairPay auth helpers
// read `process.env` directly. That's single-tenant by design: every company
// shares one set of API keys. As soon as a second tenant onboards with its
// own Coinsbuy account, the env-only model breaks.
//
// Resolution order (per provider, per tenant):
//
//   1. Look up api_credentials WHERE company_id = X AND provider = Y.
//      If the row exists, decrypt `encrypted_secret` and return it.
//
//   2. If no row exists (or the row is flagged is_configured=false),
//      return null. Callers use this signal to fall back to process.env —
//      which preserves the current VexPro behaviour until that tenant
//      uploads its own credentials through the superadmin settings panel.
//
// Storage convention inside `encrypted_secret`:
//
//   · coinsbuy   → JSON.stringify({ client_id, client_secret })
//   · unipayment → JSON.stringify({ client_id, client_secret })
//   · fairpay    → raw api_key string
//
// `extra_config` stays available for non-sensitive knobs (webhook_url,
// base_url override, sandbox toggle, etc.) and is returned alongside the
// secret so callers can override env-provided base URLs per-tenant.
//
// The resolver uses the service-role admin client (RLS on api_credentials
// is disabled — only the admin client can read it). It is therefore safe
// only from server-side code paths.
// ─────────────────────────────────────────────────────────────────────────────

import { createAdminClient } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/crypto';

export type TenantProvider = 'coinsbuy' | 'unipayment' | 'fairpay';

interface RawCredentialRow {
  encrypted_secret: string;
  iv: string;
  auth_tag: string;
  extra_config: Record<string, unknown> | null;
  is_configured: boolean;
}

/**
 * Returns the decrypted plaintext secret + extra_config for a tenant/provider
 * pair, or null if not configured. NEVER throws on "not configured" — only
 * throws when decryption itself fails (misconfigured master key, corrupted
 * ciphertext), which is a deployment bug that must surface loudly.
 */
async function readRaw(
  companyId: string,
  provider: TenantProvider,
): Promise<{ plaintext: string; extraConfig: Record<string, unknown> | null } | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('api_credentials')
    .select('encrypted_secret, iv, auth_tag, extra_config, is_configured')
    .eq('company_id', companyId)
    .eq('provider', provider)
    .maybeSingle<RawCredentialRow>();

  if (error) {
    console.warn(`[credentials] read failed for ${provider}:`, error.message);
    return null;
  }
  if (!data || !data.is_configured) return null;

  const plaintext = decryptSecret({
    ciphertext: data.encrypted_secret,
    iv: data.iv,
    authTag: data.auth_tag,
  });

  return { plaintext, extraConfig: data.extra_config };
}

// ── Coinsbuy ─────────────────────────────────────────────────────────────

export interface CoinsbuyCredentials {
  clientId: string;
  clientSecret: string;
  /** Optional per-tenant base URL override (extra_config.base_url). */
  baseUrl?: string;
}

export async function resolveCoinsbuyCredentials(
  companyId: string | null | undefined,
): Promise<CoinsbuyCredentials | null> {
  if (!companyId) return null;
  const raw = await readRaw(companyId, 'coinsbuy');
  if (!raw) return null;

  // encrypted_secret is expected to be a JSON string with client_id+secret.
  // Old rows stored as a single plaintext string won't parse — we treat
  // that as "not usable here" and fall back to env. This is defensive;
  // no such rows exist in prod today.
  try {
    const parsed = JSON.parse(raw.plaintext) as { client_id?: string; client_secret?: string };
    if (!parsed.client_id || !parsed.client_secret) return null;
    const baseUrl =
      typeof raw.extraConfig?.base_url === 'string'
        ? (raw.extraConfig.base_url as string)
        : undefined;
    return {
      clientId: parsed.client_id,
      clientSecret: parsed.client_secret,
      baseUrl,
    };
  } catch {
    console.warn('[credentials] coinsbuy secret not JSON — falling back to env');
    return null;
  }
}

// ── UniPayment ───────────────────────────────────────────────────────────

export interface UnipaymentCredentials {
  clientId: string;
  clientSecret: string;
  /** Optional per-tenant base URL override (extra_config.base_url). */
  baseUrl?: string;
}

export async function resolveUnipaymentCredentials(
  companyId: string | null | undefined,
): Promise<UnipaymentCredentials | null> {
  if (!companyId) return null;
  const raw = await readRaw(companyId, 'unipayment');
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw.plaintext) as { client_id?: string; client_secret?: string };
    if (!parsed.client_id || !parsed.client_secret) return null;
    const baseUrl =
      typeof raw.extraConfig?.base_url === 'string'
        ? (raw.extraConfig.base_url as string)
        : undefined;
    return {
      clientId: parsed.client_id,
      clientSecret: parsed.client_secret,
      baseUrl,
    };
  } catch {
    console.warn('[credentials] unipayment secret not JSON — falling back to env');
    return null;
  }
}

// ── FairPay ──────────────────────────────────────────────────────────────

export interface FairpayCredentials {
  apiKey: string;
  /** Optional per-tenant base URL override (sandbox vs prod). */
  baseUrl?: string;
}

export async function resolveFairpayCredentials(
  companyId: string | null | undefined,
): Promise<FairpayCredentials | null> {
  if (!companyId) return null;
  const raw = await readRaw(companyId, 'fairpay');
  if (!raw) return null;

  // FairPay's secret is the api_key itself — no JSON wrapping needed.
  const apiKey = raw.plaintext.trim();
  if (!apiKey) return null;
  const baseUrl =
    typeof raw.extraConfig?.base_url === 'string'
      ? (raw.extraConfig.base_url as string)
      : undefined;
  return { apiKey, baseUrl };
}
