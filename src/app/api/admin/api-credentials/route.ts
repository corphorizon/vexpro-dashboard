import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
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
// Admin-only.
// ---------------------------------------------------------------------------

const SUPPORTED_PROVIDERS = ['sendgrid', 'coinsbuy', 'unipayment', 'fairpay'];

export async function GET() {
  const auth = await verifyAdminAuth();
  if (auth instanceof NextResponse) return auth;

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('api_credentials')
    .select('provider, last_four, extra_config, is_configured, updated_at')
    .eq('company_id', auth.companyId)
    .order('provider');

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, credentials: data || [] });
}

export async function POST(request: NextRequest) {
  const auth = await verifyAdminAuth();
  if (auth instanceof NextResponse) return auth;

  if (auth.role !== 'admin') {
    return NextResponse.json(
      { success: false, error: 'Solo administradores pueden gestionar credenciales' },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => ({}));
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
      company_id: auth.companyId,
      provider,
      encrypted_secret: bundle.ciphertext,
      iv: bundle.iv,
      auth_tag: bundle.authTag,
      extra_config: extra_config ?? null,
      last_four: lastChars(secret, 4),
      is_configured: true,
      updated_at: new Date().toISOString(),
      updated_by: auth.userId,
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
      .eq('company_id', auth.companyId)
      .eq('provider', provider);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Acción no válida' }, { status: 400 });
}
