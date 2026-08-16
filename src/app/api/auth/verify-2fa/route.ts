import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, recordFailure, clearAttempts, type AttemptKind } from '@/lib/rate-limit';
import speakeasy from 'speakeasy';
import { apiError } from '@/lib/api-error';
import { TWOFA_COOKIE, mintTwofaSeal, twofaCookieOptions } from '@/lib/auth/twofa-session';

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

// Per-IP throttle (S5 lockout-DoS fix): an attacker hammering PINs from one
// IP gets their IP blocked with 429 instead of endlessly re-locking the
// victim's account. IN ADDITION to the per-user lock above.
// NOTE: 'login-ip' is not in the AttemptKind union (src/lib/rate-limit.ts is
// owned by another change); the DB `kind` column is plain text, so the cast
// is safe. Shared with /api/auth/login-gate on purpose — same attacker IP.
const IP_KIND = 'login-ip' as const;
const IP_MAX_ATTEMPTS = 10;
const IP_LOCK_MS = 15 * 60 * 1000; // 15 minutes

function getClientIp(request: NextRequest): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

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

    // Per-IP throttle BEFORE any account work (S5).
    const ip = getClientIp(request);
    const ipOpts = { key: `ip:${ip}`, kind: IP_KIND };
    const ipGate = await checkRateLimit(adminClient, ipOpts);
    if (ipGate.locked) {
      return NextResponse.json(
        { success: false, error: 'Demasiados intentos. Intenta de nuevo más tarde.' },
        { status: 429 },
      );
    }
    if (ipGate.failedCount >= IP_MAX_ATTEMPTS) {
      // Previous IP lock expired — start a fresh window instead of
      // re-locking on the very next failure.
      await clearAttempts(adminClient, ipOpts);
    }

    // DUAL-TABLE: the same email can live in company_users (tenant user)
    // OR platform_users (superadmin). Try both so superadmin login works
    // through the same PIN verification path. `table` is threaded through
    // the rest of this handler so any write targets the right row.
    type AccountRow = {
      id: string;
      twofa_secret: string | null;
      twofa_enabled: boolean;
      table: 'company_users' | 'platform_users';
    };
    let account: AccountRow | null = null;

    const { data: cu } = await adminClient
      .from('company_users')
      .select('id, twofa_secret, twofa_enabled')
      .eq('email', email)
      .maybeSingle();
    if (cu) {
      account = { ...cu, table: 'company_users' } as AccountRow;
    } else {
      const { data: pu } = await adminClient
        .from('platform_users')
        .select('id, twofa_secret, twofa_enabled')
        .eq('email', email)
        .maybeSingle();
      if (pu) account = { ...pu, table: 'platform_users' } as AccountRow;
    }

    if (!account) {
      return NextResponse.json(
        { success: false, error: 'Usuario no encontrado' },
        { status: 404 },
      );
    }

    // Re-bind to the pre-existing variable name so the rest of the handler
    // stays readable; `companyUser` is a misnomer now but changing every
    // reference would balloon the diff.
    const companyUser = account;

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
      // Count the failure against the caller's IP first (S5). If the IP
      // just hit its cap, answer 429 WITHOUT pushing the account closer to
      // its lock — blocks hammering IPs instead of DoS-ing the victim.
      const ipState = await recordFailure(adminClient, {
        ...ipOpts,
        max: IP_MAX_ATTEMPTS,
        lockMs: IP_LOCK_MS,
      });
      if (ipState.locked) {
        return NextResponse.json(
          { success: false, error: 'Demasiados intentos. Intenta de nuevo más tarde.' },
          { status: 429 },
        );
      }

      const next = await recordFailure(adminClient, {
        ...rlOpts,
        max: MAX_ATTEMPTS,
        lockMs: LOCK_MS,
      });
      const remaining = Math.max(0, MAX_ATTEMPTS - next.failedCount);

      // On 3rd consecutive 2FA failure, also lock the full account so a
      // password reset is required to unlock (policy: any 3 auth failures
      // lock the account).
      if (next.locked && account.table === 'company_users') {
        // Only tenant users have locked_until — platform_users has no
        // such column today. For superadmins the rate-limit table still
        // gates further attempts for 15 min; full account lockout is
        // tenant-only.
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

    const { data: signInData, error: signInError } = await tempClient.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      // Wrong password with a valid PIN — still counts against the IP (S5).
      await recordFailure(adminClient, {
        ...ipOpts,
        max: IP_MAX_ATTEMPTS,
        lockMs: IP_LOCK_MS,
      });
      return NextResponse.json(
        { success: false, error: 'Credenciales inválidas' },
        { status: 401 },
      );
    }

    // PIN is correct → clear rate limit + stamp last_login_at for this
    // membership (post-2FA is the real "successful login" moment).
    // last_login_at only exists on company_users; skip for superadmins.
    await clearAttempts(adminClient, rlOpts);
    if (ipGate.failedCount > 0) {
      await clearAttempts(adminClient, ipOpts);
    }
    if (account.table === 'company_users') {
      await adminClient
        .from('company_users')
        .update({ last_login_at: new Date().toISOString() })
        .eq('id', companyUser.id);
    }

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

    // ── SELLO 2FA ────────────────────────────────────────────────────────
    // Éste es el ÚNICO punto del login donde alguien probó el segundo factor,
    // así que es el único que puede emitir el sello. Se emite ANTES de que el
    // navegador haga su `signInWithPassword`, pero eso no importa: la cookie
    // no depende de la sesión de GoTrue, sólo del `auth.users.id` — que
    // acabamos de confirmar con la contraseña correcta.
    //
    // Sin sello, `updateSession` (middleware) y verifyAuth/verifyAdminAuth
    // rechazan cualquier sesión de un usuario con twofa_enabled = true.
    const response = NextResponse.json({ success: true, verified: true });
    const authUserId = signInData?.user?.id;
    if (authUserId) {
      const seal = await mintTwofaSeal(authUserId);
      // seal === null ⇒ no hay clave HMAC; `twofaSealAvailable()` también es
      // false, así que el guardián no exige nada y nadie queda afuera.
      if (seal) response.cookies.set(TWOFA_COOKIE, seal, twofaCookieOptions());
    }
    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[verify-2fa] Unhandled error:', message);
    return apiError('auth/verify-2fa', err, { status: 500 });
  }
}
