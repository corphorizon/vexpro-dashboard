import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, recordFailure, clearAttempts } from '@/lib/rate-limit';
import speakeasy from 'speakeasy';

// ---------------------------------------------------------------------------
// POST /api/auth/verify-2fa
//
// Server-side 2FA PIN verification during login. Receives email + password
// + pin, verifies the PIN against the stored twofa_secret (server-side only),
// and returns whether verification passed. If it did, the client should
// call signInWithPassword again to establish a proper Supabase session.
//
// Rate-limited: max 3 failed attempts per user, 15-minute lockout.
// State is persisted in the twofa_attempts Supabase table so it survives
// serverless worker restarts and is shared across instances.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const LOCK_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password, pin } = body as {
      email?: string;
      password?: string;
      pin?: string;
    };

    if (!email || !password || !pin) {
      return NextResponse.json(
        { success: false, error: 'email, password y pin son requeridos' },
        { status: 400 },
      );
    }

    if (!/^\d{6}$/.test(pin)) {
      return NextResponse.json(
        { success: false, error: 'El PIN debe tener 6 dígitos' },
        { status: 400 },
      );
    }

    const adminClient = createAdminClient();

    // Look up the user's company_users record to get twofa_secret
    const { data: companyUser, error: lookupError } = await adminClient
      .from('company_users')
      .select('id, twofa_secret, twofa_enabled')
      .eq('email', email)
      .maybeSingle();

    if (lookupError || !companyUser) {
      return NextResponse.json(
        { success: false, error: 'Usuario no encontrado' },
        { status: 404 },
      );
    }

    if (!companyUser.twofa_enabled || !companyUser.twofa_secret) {
      return NextResponse.json(
        { success: false, error: '2FA no está habilitado para este usuario' },
        { status: 400 },
      );
    }

    const rlOpts = { key: companyUser.id, kind: 'verify-2fa' as const };

    // Check rate-limit (durable, cross-worker)
    const gate = await checkRateLimit(adminClient, rlOpts);
    if (gate.locked) {
      const minutes = Math.ceil(gate.waitMs / 60000);
      return NextResponse.json(
        {
          success: false,
          error: `Cuenta bloqueada. Intenta en ${minutes} minuto${minutes === 1 ? '' : 's'}.`,
          locked: true,
          waitMs: gate.waitMs,
        },
        { status: 429 },
      );
    }

    // Verify TOTP code server-side
    const isValid = speakeasy.totp.verify({
      secret: companyUser.twofa_secret,
      encoding: 'base32',
      token: pin,
      window: 1,
    });

    if (!isValid) {
      const next = await recordFailure(adminClient, {
        ...rlOpts,
        max: MAX_ATTEMPTS,
        lockMs: LOCK_MS,
      });
      const remaining = Math.max(0, MAX_ATTEMPTS - next.failedCount);

      // On 3rd consecutive 2FA failure, also lock the full account so a
      // password reset is required to unlock (policy: any 3 auth failures
      // lock the account).
      if (next.locked) {
        const ACCOUNT_LOCK_MS = 24 * 60 * 60 * 1000;
        await adminClient
          .from('company_users')
          .update({
            locked_until: new Date(Date.now() + ACCOUNT_LOCK_MS).toISOString(),
          })
          .eq('id', companyUser.id);
      }

      return NextResponse.json(
        {
          success: false,
          error: next.locked
            ? 'Demasiados intentos fallidos. Tu cuenta ha sido bloqueada. Restablece tu contraseña o el 2FA.'
            : `PIN incorrecto. ${remaining} intento${remaining === 1 ? '' : 's'} restantes.`,
          locked: next.locked,
        },
        { status: next.locked ? 423 : 401 },
      );
    }

    // Verify credentials are still valid by signing in temporarily
    const { createClient } = await import('@supabase/supabase-js');
    const tempClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { error: signInError } = await tempClient.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      return NextResponse.json(
        { success: false, error: 'Credenciales inválidas' },
        { status: 401 },
      );
    }

    // PIN is correct → clear rate limit + stamp last_login_at for this
    // membership (post-2FA is the real "successful login" moment).
    await clearAttempts(adminClient, rlOpts);
    await adminClient
      .from('company_users')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', companyUser.id);

    // Sign out the temp client — real sign-in happens on the browser.
    // If this fails, the refresh token could remain valid. Log loudly so
    // operators notice and can invalidate it manually.
    const { error: signOutError } = await tempClient.auth.signOut();
    if (signOutError) {
      console.error(
        '[verify-2fa] SECURITY: temp signOut failed — orphan refresh token possible',
        { userId: companyUser.id, error: signOutError.message },
      );
    }

    return NextResponse.json({ success: true, verified: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[verify-2fa] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
