import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { clearAttempts } from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password-confirm
//
// Consumes a one-shot token from /api/auth/forgot-password and updates the
// user's password via Supabase Admin API. Also:
//   - clears locked_until, failed_login_count, must_change_password
//   - clears verify-2fa rate-limit counters (gives the user a clean slate)
//
// Body: { token: string, newPassword: string }
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { token, newPassword } = body as { token?: string; newPassword?: string };

    if (!token || !newPassword) {
      return NextResponse.json(
        { success: false, error: 'token y nueva contraseña requeridos' },
        { status: 400 },
      );
    }

    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return NextResponse.json(
        { success: false, error: 'La contraseña debe tener al menos 8 caracteres' },
        { status: 400 },
      );
    }

    const adminClient = createAdminClient();
    const tokenHash = sha256(token);

    const { data: tokenRow } = await adminClient
      .from('password_reset_tokens')
      .select('id, user_id, expires_at, consumed_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (!tokenRow) {
      return NextResponse.json(
        { success: false, error: 'Enlace inválido o expirado' },
        { status: 400 },
      );
    }

    if (tokenRow.consumed_at) {
      return NextResponse.json(
        { success: false, error: 'Este enlace ya fue utilizado' },
        { status: 400 },
      );
    }

    if (new Date(tokenRow.expires_at).getTime() < Date.now()) {
      return NextResponse.json(
        { success: false, error: 'El enlace expiró' },
        { status: 400 },
      );
    }

    // Update the user's password via Supabase Admin API
    const { error: updateErr } = await adminClient.auth.admin.updateUserById(
      tokenRow.user_id,
      { password: newPassword },
    );

    if (updateErr) {
      console.error('[reset-password-confirm] password update failed:', updateErr.message);
      return NextResponse.json(
        { success: false, error: 'No se pudo actualizar la contraseña' },
        { status: 500 },
      );
    }

    // Mark token consumed + clear lockout state on the company_users row
    await adminClient
      .from('password_reset_tokens')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', tokenRow.id);

    const { data: companyUser } = await adminClient
      .from('company_users')
      .select('id')
      .eq('user_id', tokenRow.user_id)
      .maybeSingle();

    if (companyUser) {
      await adminClient
        .from('company_users')
        .update({
          failed_login_count: 0,
          locked_until: null,
          must_change_password: false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', companyUser.id);

      // Clear any stale 2FA rate-limit counters for this user
      await clearAttempts(adminClient, { key: companyUser.id, kind: 'verify-2fa' });
      await clearAttempts(adminClient, { key: tokenRow.user_id, kind: 'verify-pin' });
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[reset-password-confirm] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
