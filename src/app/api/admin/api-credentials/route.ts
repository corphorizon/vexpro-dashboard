import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { encryptSecret, lastChars } from '@/lib/crypto';

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

// SendGrid dropped from the tenant-facing list — transactional email is
// always sent from the Horizon SendGrid account (env var SENDGRID_API_KEY).
// The code path that reads api_credentials for sendgrid still works for
// legacy rows, but new writes via this route are rejected.
const SUPPORTED_PROVIDERS = ['coinsbuy', 'unipayment', 'fairpay'];

/**
 * Resolve the effective `company_id` for the request. Returns either:
 *   - the company_id to operate on + the caller's auth user id, or
 *   - an error NextResponse ready to be returned.
 */
async function resolveCompanyAndAuth(
  explicitCompanyId: string | null,
): Promise<{ companyId: string; userId: string } | NextResponse> {
  if (explicitCompanyId) {
    // Explicit target → must be superadmin.
    const sa = await verifySuperadminAuth();
    if (sa instanceof NextResponse) return sa;
    return { companyId: explicitCompanyId, userId: sa.userId };
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
  return { companyId: admin.companyId, userId: admin.userId };
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
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, credentials: data || [] });
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

    let bundle;
    try {
      bundle = encryptSecret(secret);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error de encriptación';
      console.error('[api-credentials] encrypt error:', msg);
      return NextResponse.json({ success: false, error: msg }, { status: 500 });
    }

    const payload = {
      company_id: ctx.companyId,
      provider,
      encrypted_secret: bundle.ciphertext,
      iv: bundle.iv,
      auth_tag: bundle.authTag,
      extra_config: extra_config ?? null,
      last_four: lastChars(secret, 4),
      is_configured: true,
      updated_at: new Date().toISOString(),
      updated_by: ctx.userId,
    };

    const { error } = await adminClient
      .from('api_credentials')
      .upsert(payload, { onConflict: 'company_id,provider' });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  }

  if (action === 'delete') {
    const { error } = await adminClient
      .from('api_credentials')
      .delete()
      .eq('company_id', ctx.companyId)
      .eq('provider', provider);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Acción no válida' }, { status: 400 });
}
