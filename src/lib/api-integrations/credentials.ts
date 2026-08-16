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
//   · paypros    → JSON.stringify({ merchant_id, api_key, sign_key })
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

export type TenantProvider = 'coinsbuy' | 'unipayment' | 'fairpay' | 'orion_crm' | 'paypros';

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

/**
 * Parsea `extra_config.fee_pct` — el porcentaje de comisión que el proveedor
 * cobra por depósito (en unidades de porcentaje: 8 = 8%).
 *
 * Ni FairPay ni UniPayment exponen su comisión por API (verificado
 * 2026-08-03 contra ambas APIs en vivo), así que el superadmin la configura
 * por tenant desde el panel de credenciales. Válido: número finito entre
 * 0 y 30; ausente o fuera de rango → null (el caller decide el fallback).
 */
export function getProviderFeePct(
  extraConfig: Record<string, unknown> | null | undefined,
): number | null {
  const v = extraConfig?.fee_pct;
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'string' && v.trim() !== ''
        ? Number(v)
        : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 30) return null;
  return n;
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
  /** Comisión del proveedor por tenant (extra_config.fee_pct, 8 = 8%). */
  feePct: number | null;
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
      feePct: getProviderFeePct(raw.extraConfig),
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
  /** Comisión del proveedor por tenant (extra_config.fee_pct, 8 = 8%). */
  feePct: number | null;
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
  return { apiKey, baseUrl, feePct: getProviderFeePct(raw.extraConfig) };
}

// ── Orion CRM ────────────────────────────────────────────────────────────
//
// Orion is the broker-side CRM — it owns registered users, prop firm
// sales, P&L, and purchase history. Per-tenant API key; base URL is an
// `extra_config.base_url` override so each tenant can point at its own
// environment (sandbox vs prod) without touching env.
//
// Shape mirrors FairPay's "single api_key string" model — Orion uses a
// single Bearer-style key, not a client_id/client_secret pair.

export interface OrionCrmCredentials {
  apiKey: string;
  /** Optional per-tenant base URL override. */
  baseUrl?: string;
}

export async function resolveOrionCrmCredentials(
  companyId: string | null | undefined,
): Promise<OrionCrmCredentials | null> {
  if (!companyId) return null;
  const raw = await readRaw(companyId, 'orion_crm');
  if (!raw) return null;

  const apiKey = raw.plaintext.trim();
  if (!apiKey) return null;
  const baseUrl =
    typeof raw.extraConfig?.base_url === 'string'
      ? (raw.extraConfig.base_url as string)
      : undefined;
  return { apiKey, baseUrl };
}

// ── Pay-Pros ─────────────────────────────────────────────────────────────
//
// Pay-Pros necesita TRES secretos (merchant_id, api_key, sign_key), así que
// se guardan juntos como JSON dentro de un único `encrypted_secret` —
// mismo patrón que Coinsbuy con su par client_id/client_secret.
//
// `base_url` NO es secreto y vive en extra_config. Default = producción
// (la URL que nos dio Pay-Pros). La documentación menciona un entorno de
// sandbox ("SB") cuya URL no conocemos: cuando la tengamos, se configura
// por tenant desde el panel sin tocar código.
//
// `webhook_token` (extra_config, 32 bytes hex) identifica a la empresa en
// la URL del webhook entrante, porque Pay-Pros no manda el merchant en el
// cuerpo de la notificación. Lo genera la ruta de guardado
// (/api/admin/api-credentials) la primera vez y NUNCA se regenera: la URL
// ya quedó registrada del lado de Pay-Pros.

/** URL de producción de Pay-Pros. Override por tenant en extra_config.base_url. */
export const PAYPROS_DEFAULT_BASE_URL = 'https://master-api.pay-pros.com/';

export interface PayprosCredentials {
  merchantId: string;
  apiKey: string;
  signKey: string;
  baseUrl: string;
}

export async function resolvePayprosCredentials(
  companyId: string | null | undefined,
): Promise<PayprosCredentials | null> {
  if (!companyId) return null;
  const raw = await readRaw(companyId, 'paypros');
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw.plaintext) as {
      merchant_id?: string;
      api_key?: string;
      sign_key?: string;
    };
    if (!parsed.merchant_id || !parsed.api_key || !parsed.sign_key) return null;

    const configured =
      typeof raw.extraConfig?.base_url === 'string' ? raw.extraConfig.base_url.trim() : '';

    return {
      merchantId: parsed.merchant_id,
      apiKey: parsed.api_key,
      signKey: parsed.sign_key,
      baseUrl: configured || PAYPROS_DEFAULT_BASE_URL,
    };
  } catch {
    console.warn('[credentials] paypros secret not JSON — treating as not configured');
    return null;
  }
}

/**
 * Token del webhook de Pay-Pros para un tenant (extra_config.webhook_token).
 * Se lee sin descifrar el secreto. null si la empresa no tiene credencial
 * o si la fila es anterior a la generación del token.
 */
export async function resolvePayprosWebhookToken(
  companyId: string | null | undefined,
): Promise<string | null> {
  if (!companyId) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('api_credentials')
    .select('extra_config')
    .eq('company_id', companyId)
    .eq('provider', 'paypros')
    .maybeSingle<{ extra_config: Record<string, unknown> | null }>();

  if (error) {
    console.warn('[credentials] paypros webhook_token read failed:', error.message);
    return null;
  }
  const token = data?.extra_config?.webhook_token;
  return typeof token === 'string' && token.trim() !== '' ? token : null;
}

/**
 * Inverso del anterior: dado el token que viene en la URL del webhook,
 * devuelve el company_id dueño de esa credencial. null si no matchea —
 * el caller debe responder 404/401 sin filtrar cuál de las dos cosas falló.
 */
export async function findCompanyByPayprosWebhookToken(
  token: string | null | undefined,
): Promise<string | null> {
  const clean = typeof token === 'string' ? token.trim() : '';
  // 32 bytes hex = 64 chars. Filtramos acá para no mandar basura a la DB.
  if (!/^[0-9a-f]{64}$/i.test(clean)) return null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('api_credentials')
    .select('company_id')
    .eq('provider', 'paypros')
    .eq('extra_config->>webhook_token', clean)
    .maybeSingle<{ company_id: string }>();

  if (error) {
    console.warn('[credentials] paypros webhook token lookup failed:', error.message);
    return null;
  }
  return data?.company_id ?? null;
}
