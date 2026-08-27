import { randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { encryptSecret, lastChars } from '@/lib/crypto';
import { sanitizeDbError } from '@/lib/errors';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import { notify } from '@/lib/notifications/notify';
import { PAYPROS_DEFAULT_BASE_URL } from '@/lib/api-integrations/credentials';
import { parseMt5SqlSecret } from '@/lib/api-integrations/mt5-sql/validate';
import { parseMongoUri } from '@/lib/api-integrations/orion-mongo/validate';

// ---------------------------------------------------------------------------
// /api/admin/api-credentials
//
// GET                                     → list configured providers (no secrets)
// POST {action:'upsert', provider, secret, extra_config?} → save / replace credential
// POST {action:'delete', provider}        → remove credential
//
// Secrets are AES-256-GCM encrypted at rest. The plaintext NEVER leaves the
// server after save. Reads return only provider/last_four/extra_config so the
// UI can show "••••u-Q" style masks.
//
// Authorization:
//   · Company admin: no `company_id` in query/body → uses caller's companyId.
//   · Horizon superadmin: MUST pass `company_id` explicitly (query or body) —
//     targets that tenant. This is the path used by the superadmin panel.
// ---------------------------------------------------------------------------

// Re-enabled SendGrid for tenant-branded sender (Ajuste 3.1): each company
// can store its own API key + from_email/from_name in extra_config so report
// emails go out from `dashboard@<tenant-domain>` instead of Horizon's default.
// Falls back to env SENDGRID_* when a tenant hasn't configured one yet
// (emailService.getSendGridConfig handles the precedence).
// 'orion_crm' was added in migration 033. It follows the same storage
// convention as fairpay (single api_key as encrypted_secret, base_url
// in extra_config).
// 'paypros' guarda TRES secretos como JSON en encrypted_secret
// ({merchant_id, api_key, sign_key}) y en extra_config lleva base_url +
// webhook_token (el token que identifica al tenant en la URL entrante).
// Migración 087 — bases de datos propias del broker, ambas de SOLO LECTURA:
// 'mt5_sql'     guarda JSON {engine, host, port, database, user, password} y
//               repite lo no secreto (engine/host/port/database) en extra_config
//               para que el panel muestre a dónde apunta sin descifrar.
// 'orion_mongo' guarda la connection string ENTERA (lleva usuario y contraseña)
//               y en extra_config {database, host_hint}.
// Migración 100 — 'anthropic' guarda la API key cruda (sk-ant-…), igual que
// fairpay. Es la clave que paga el asistente de IA de ESE bróker: en un
// white-label una sola clave global haría el consumo inatribuible.
const SUPPORTED_PROVIDERS = ['sendgrid', 'coinsbuy', 'unipayment', 'fairpay', 'fairpay_banking', 'orion_crm', 'paypros', 'mt5_sql', 'orion_mongo', 'anthropic'];

/**
 * Origen público del dashboard, para armar la URL del webhook que el
 * superadmin le pasa a Pay-Pros. NEXT_PUBLIC_APP_URL manda; si no está,
 * usamos el origin de la request (útil en previews).
 */
function publicOrigin(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  return (configured || request.nextUrl.origin).replace(/\/+$/, '');
}

function payprosWebhookUrl(request: NextRequest, token: unknown): string | null {
  if (typeof token !== 'string' || token.trim() === '') return null;
  return `${publicOrigin(request)}/api/webhooks/paypros/${token.trim()}`;
}

/**
 * Resolve the effective `company_id` for the request. Returns either:
 *   - the company_id to operate on + the caller's auth user id, or
 *   - an error NextResponse ready to be returned.
 */
async function resolveCompanyAndAuth(
  explicitCompanyId: string | null,
): Promise<{ companyId: string; userId: string; actorName: string } | NextResponse> {
  if (explicitCompanyId) {
    // Explicit target → must be superadmin.
    const sa = await verifySuperadminAuth();
    if (sa instanceof NextResponse) return sa;
    return { companyId: explicitCompanyId, userId: sa.userId, actorName: sa.name || sa.email };
  }
  // Implicit target → regular admin flow.
  const admin = await verifyAdminAuth();
  if (admin instanceof NextResponse) return admin;
  if (admin.role !== 'admin') {
    return NextResponse.json(
      { success: false, error: 'Solo administradores pueden gestionar credenciales' },
      { status: 403 },
    );
  }
  return { companyId: admin.companyId, userId: admin.userId, actorName: admin.name || admin.email };
}

/**
 * Rastro de un cambio de credencial. Nunca recibe el secreto ni el last_four:
 * el aviso viaja a la bandeja de varios admins y el audit log se exporta.
 */
async function recordCredentialChange(
  adminClient: ReturnType<typeof createAdminClient>,
  ctx: { companyId: string; userId: string; actorName: string },
  provider: string,
  action: 'update' | 'delete',
) {
  await serverAuditLog(adminClient, {
    companyId: ctx.companyId,
    actorId: ctx.userId,
    actorName: ctx.actorName,
    action,
    module: 'settings',
    details: action === 'delete'
      ? `Credencial eliminada: ${provider}`
      : `Credencial guardada/reemplazada: ${provider}`,
  });

  void notify(adminClient, {
    companyId: ctx.companyId,
    type: 'security.api_credentials',
    params: { actor: ctx.actorName, target: provider, provider },
    // Sin link: las credenciales se gestionan desde el panel de superadmin,
    // que no es una ruta a la que se pueda mandar a un admin de empresa.
    excludeUserIds: [ctx.userId],
  });
}

export async function GET(request: NextRequest) {
  const explicit = request.nextUrl.searchParams.get('company_id');
  const ctx = await resolveCompanyAndAuth(explicit);
  if (ctx instanceof NextResponse) return ctx;

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('api_credentials')
    .select('provider, last_four, extra_config, is_configured, updated_at')
    .eq('company_id', ctx.companyId)
    .order('provider');

  if (error) {
    return NextResponse.json(sanitizeDbError(error, 'api-credentials:list'), { status: 500 });
  }

  // Pay-Pros: además del enmascarado habitual, devolvemos la URL completa
  // del webhook para que el superadmin la copie y la registre en Pay-Pros.
  // Sigue sin salir ningún secreto: webhook_token no es una credencial de
  // API, es el identificador del tenant dentro de una URL que igual queda
  // en manos de Pay-Pros.
  const credentials = (data || []).map((row) => {
    if (row.provider !== 'paypros') return row;
    const extra = (row.extra_config || {}) as Record<string, unknown>;
    return { ...row, webhook_url: payprosWebhookUrl(request, extra.webhook_token) };
  });

  return NextResponse.json({ success: true, credentials });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  // company_id can come from query or body — both accepted so the panel can
  // POST without re-appending to the URL.
  const explicit =
    request.nextUrl.searchParams.get('company_id') || (body as { company_id?: string }).company_id || null;

  const ctx = await resolveCompanyAndAuth(explicit);
  if (ctx instanceof NextResponse) return ctx;

  const { action, provider } = body as { action?: string; provider?: string };

  if (!provider || !SUPPORTED_PROVIDERS.includes(provider)) {
    return NextResponse.json(
      { success: false, error: 'Provider no soportado' },
      { status: 400 },
    );
  }

  const adminClient = createAdminClient();

  if (action === 'upsert') {
    const { secret, extra_config } = body as {
      secret?: string;
      extra_config?: Record<string, unknown>;
    };

    if (!secret || typeof secret !== 'string' || secret.length < 8) {
      return NextResponse.json(
        { success: false, error: 'El secret debe tener al menos 8 caracteres' },
        { status: 400 },
      );
    }

    // Validación de extra_config.fee_pct (comisión del proveedor, fairpay/
    // unipayment): número entre 0 y 30. El resolver (getProviderFeePct)
    // también la ignora si está fuera de rango, pero rechazamos acá para
    // que el superadmin vea el error en vez de un silencio.
    if (
      extra_config &&
      typeof extra_config === 'object' &&
      'fee_pct' in extra_config &&
      extra_config.fee_pct != null
    ) {
      const feePct = Number(extra_config.fee_pct);
      if (!Number.isFinite(feePct) || feePct < 0 || feePct > 30) {
        return NextResponse.json(
          { success: false, error: 'fee_pct debe ser un número entre 0 y 30' },
          { status: 400 },
        );
      }
    }

    // ── Pay-Pros ────────────────────────────────────────────────────────
    // El secreto llega como JSON {merchant_id, api_key, sign_key} (mismo
    // patrón que coinsbuy con su par). extra_config lleva base_url +
    // webhook_token; el token se genera UNA sola vez y se conserva entre
    // guardados — regenerarlo rompería la URL ya registrada en Pay-Pros.
    let effectiveExtraConfig: Record<string, unknown> | null = extra_config ?? null;
    let lastFour = lastChars(secret, 4);

    if (provider === 'paypros') {
      let parsed: { merchant_id?: unknown; api_key?: unknown; sign_key?: unknown };
      try {
        parsed = JSON.parse(secret);
      } catch {
        return NextResponse.json(
          { success: false, error: 'Pay-Pros: el secreto debe ser JSON {merchant_id, api_key, sign_key}' },
          { status: 400 },
        );
      }

      const merchantId = typeof parsed.merchant_id === 'string' ? parsed.merchant_id.trim() : '';
      const apiKey = typeof parsed.api_key === 'string' ? parsed.api_key.trim() : '';
      const signKey = typeof parsed.sign_key === 'string' ? parsed.sign_key.trim() : '';
      if (!merchantId || !apiKey || !signKey) {
        return NextResponse.json(
          { success: false, error: 'Pay-Pros: Merchant ID, API Key y Sign Key son obligatorios' },
          { status: 400 },
        );
      }

      const rawBaseUrl =
        typeof extra_config?.base_url === 'string' && extra_config.base_url.trim() !== ''
          ? extra_config.base_url.trim()
          : PAYPROS_DEFAULT_BASE_URL;
      if (!rawBaseUrl.startsWith('https://') || !rawBaseUrl.endsWith('/')) {
        return NextResponse.json(
          { success: false, error: 'Pay-Pros: la Base URL debe empezar con https:// y terminar en /' },
          { status: 400 },
        );
      }

      // Token existente (si lo hay) → se conserva.
      const { data: existing } = await adminClient
        .from('api_credentials')
        .select('extra_config')
        .eq('company_id', ctx.companyId)
        .eq('provider', 'paypros')
        .maybeSingle<{ extra_config: Record<string, unknown> | null }>();

      const previousToken = existing?.extra_config?.webhook_token;
      const webhookToken =
        typeof previousToken === 'string' && previousToken.trim() !== ''
          ? previousToken.trim()
          : randomBytes(32).toString('hex');

      effectiveExtraConfig = {
        ...(existing?.extra_config ?? {}),
        ...(extra_config ?? {}),
        base_url: rawBaseUrl,
        webhook_token: webhookToken,
      };
      // El JSON completo termina en `"}`, que como máscara no dice nada.
      // Mostramos los últimos 4 de la API Key, que es lo que el superadmin
      // puede comparar contra el panel de Pay-Pros.
      lastFour = lastChars(apiKey, 4);
    }

    // ── MT5 SQL ─────────────────────────────────────────────────────────
    // El secreto es el JSON de conexión completo. La validación (motor
    // permitido, host sin esquema, puerto, campos obligatorios) vive en
    // parseMt5SqlSecret y la comparte el resolver: una sola fuente.
    if (provider === 'mt5_sql') {
      const parsed = parseMt5SqlSecret(secret);
      if (!parsed.ok) {
        return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
      }
      const { engine, host, port, database, password } = parsed.value;
      // extra_config repite SOLO lo no secreto. El host técnicamente es
      // sensible (es la puerta de la base del broker), así que se guarda pero
      // el panel lo muestra truncado.
      effectiveExtraConfig = {
        ...(extra_config ?? {}),
        engine,
        host,
        port,
        database,
      };
      // El JSON termina en `"}`: como máscara no dice nada. Mostramos los
      // últimos 4 de la contraseña, que es lo que el superadmin puede
      // comparar contra lo que le pasó el hosting.
      lastFour = lastChars(password, 4);
    }

    // ── Orion MongoDB ───────────────────────────────────────────────────
    // El secreto es la connection string entera. Nunca sale del servidor:
    // en extra_config queda sólo el host (sin credenciales) y la base.
    if (provider === 'orion_mongo') {
      const parsed = parseMongoUri(secret);
      if (!parsed.ok) {
        return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
      }
      const explicitDb =
        typeof extra_config?.database === 'string' && extra_config.database.trim() !== ''
          ? extra_config.database.trim()
          : null;
      const database = explicitDb ?? parsed.value.uriDatabase;
      if (!database) {
        return NextResponse.json(
          {
            success: false,
            error: 'Orion Mongo: indicá la base de datos (en el campo o en el path de la connection string).',
          },
          { status: 400 },
        );
      }
      effectiveExtraConfig = {
        ...(extra_config ?? {}),
        database,
        host_hint: parsed.value.hostHint,
      };
      // Últimos 4 del HOST, no de la URI: los últimos caracteres de la URI
      // suelen ser opciones (…&w=majority) y no identifican nada.
      lastFour = lastChars(parsed.value.hostHint, 4);
    }

    let bundle;
    try {
      bundle = encryptSecret(secret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de encriptación';
      console.error('[api-credentials] encrypt error:', msg);
      return apiError('admin/api-credentials', err, { status: 500 });
    }

    const payload = {
      company_id: ctx.companyId,
      provider,
      encrypted_secret: bundle.ciphertext,
      iv: bundle.iv,
      auth_tag: bundle.authTag,
      extra_config: effectiveExtraConfig,
      last_four: lastFour,
      is_configured: true,
      updated_at: new Date().toISOString(),
      updated_by: ctx.userId,
    };

    const { error } = await adminClient
      .from('api_credentials')
      .upsert(payload, { onConflict: 'company_id,provider' });

    if (error) {
      return NextResponse.json(sanitizeDbError(error, 'api-credentials:upsert'), { status: 500 });
    }

    await recordCredentialChange(adminClient, ctx, provider, 'update');
    return NextResponse.json({ success: true });
  }

  if (action === 'delete') {
    const { error } = await adminClient
      .from('api_credentials')
      .delete()
      .eq('company_id', ctx.companyId)
      .eq('provider', provider);

    if (error) {
      return NextResponse.json(sanitizeDbError(error, 'api-credentials:delete'), { status: 500 });
    }
    await recordCredentialChange(adminClient, ctx, provider, 'delete');
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Acción no válida' }, { status: 400 });
}
