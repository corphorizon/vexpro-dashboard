import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { clearAttempts } from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// POST /api/auth/confirm-2fa-reset
//
// Consumes a 6-digit code from /api/auth/request-2fa-reset. If valid:
//   - Disables 2FA on the account
//   - Clears any pending setup secret
//   - Sets force_2fa_setup = true (user must set up new 2FA on next login)
//   - Clears locked_until and failed counters
//
// Limits: the code itself can be attempted up to 3 times before being
// invalidated. After 3 bad attempts or expiration, the user must request
// a fresh code.
// ---------------------------------------------------------------------------

const MAX_CODE_ATTEMPTS = 3;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { email, code } = body as { email?: string; code?: string };

    if (!email || !code) {
      return NextResponse.json({ success: false, error: 'email y code requeridos' }, { status: 400 });
    }
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ success: false, error: 'El código debe tener 6 dígitos' }, { status: 400 });
    }

    const normalized = email.toLowerCase().trim();
    const adminClient = createAdminClient();

    const { data: companyUser } = await adminClient
      .from('company_users')
      .select('id, user_id')
      .eq('email', normalized)
      .maybeSingle();

    if (!companyUser) {
      return NextResponse.json({ success: false, error: 'Código inválido o expirado' }, { status: 400 });
    }

    // Latest outstanding code
    const { data: codeRow } = await adminClient
      .from('twofa_reset_codes')
      .select('id, code_hash, expires_at, attempts, consumed_at')
      .eq('user_id', companyUser.user_id)
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!codeRow) {
      return NextResponse.json({ success: false, error: 'No hay código pendiente. Solicita uno nuevo.' }, { status: 400 });
    }

    if (new Date(codeRow.expires_at).getTime() < Date.now()) {
      // Consume expired record
      await adminClient.from('twofa_reset_codes').update({ consumed_at: new Date().toISOString() }).eq('id', codeRow.id);
      return NextResponse.json({ success: false, error: 'El código expiró. Solicita uno nuevo.' }, { status: 400 });
    }

    if (codeRow.attempts >= MAX_CODE_ATTEMPTS) {
      await adminClient.from('twofa_reset_codes').update({ consumed_at: new Date().toISOString() }).eq('id', codeRow.id);
      return NextResponse.json({ success: false, error: 'Demasiados intentos. Solicita un nuevo código.' }, { status: 429 });
    }

    const match = sha256(code) === codeRow.code_hash;
    if (!match) {
      const nextAttempts = codeRow.attempts + 1;
      await adminClient
        .from('twofa_reset_codes')
        .update({ attempts: nextAttempts })
        .eq('id', codeRow.id);
      const remaining = MAX_CODE_ATTEMPTS - nextAttempts;
      return NextResponse.json(
        {
          success: false,
          error: remaining > 0
            ? `Código incorrecto. ${remaining} intento${remaining === 1 ? '' : 's'} restantes.`
            : 'Demasiados intentos. Solicita un nuevo código.',
        },
        { status: 401 },
      );
    }

    // Valid — disable 2FA, consume code, clear locks
    await Promise.all([
      adminClient
        .from('twofa_reset_codes')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', codeRow.id),
      adminClient
        .from('company_users')
        .update({
          twofa_enabled: false,
          twofa_secret: null,
          twofa_pending_secret: null,
          twofa_pending_at: null,
          force_2fa_setup: true,
          locked_until: null,
          failed_login_count: 0,
          updated_at: new Date().toISOString(),
        })
        .eq('id', companyUser.id),
      clearAttempts(adminClient, { key: companyUser.id, kind: 'verify-2fa' }),
      clearAttempts(adminClient, { key: companyUser.user_id, kind: 'verify-pin' }),
    ]);

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[confirm-2fa-reset] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
