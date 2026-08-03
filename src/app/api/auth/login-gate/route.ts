import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { isDev2faBypassEnabled } from '@/lib/auth/dev-2fa-bypass';
import { checkRateLimit, recordFailure, clearAttempts, type AttemptKind } from '@/lib/rate-limit';
import { apiError } from '@/lib/api-error';

// ---------------------------------------------------------------------------
// POST /api/auth/login-gate
//
// Server-side pre-flight for login. Validates credentials WITHOUT setting a
// cookie session, tracks failed attempts, and applies account lockout.
//
// Flow:
//   1. Look up company_users by email
//   2. If account is locked (locked_until > now) → 423
//   3. Verify password via temp supabase client (no cookie)
//   4. On fail: increment failed_login_count. If >= MAX_ATTEMPTS → set
//      locked_until = now + LOCK_MS. Return 401 with lock info.
//   5. On success: clear counter + lock. Return 2FA / password-change state.
//
// Client then:
//   - If needs2fa → show PIN screen → /api/auth/verify-2fa (existing)
//   - Else → calls supabase.auth.signInWithPassword to establish real session
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const LOCK_MS = 24 * 60 * 60 * 1000; // 24 hours

// Per-IP throttle (S5 lockout-DoS fix): an attacker hammering an email from
// one IP gets their IP blocked with 429 instead of endlessly re-locking the
// victim's account. Durable (twofa_attempts table), IN ADDITION to the
// account lock above.
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
    const body = await request.json().catch(() => ({}));
    const { email, password } = body as { email?: string; password?: string };

    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: 'email y password requeridos' },
        { status: 400 },
      );
    }

    const adminClient = createAdminClient();

    // Per-IP throttle BEFORE any account work (S5). If this IP is hammering
    // the endpoint, answer 429 without touching any account's lock state.
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

    // Look up user state. Avoid leaking existence details: we respond with a
    // generic "credentials invalid" if the account doesn't exist.
    // Join companies.status so we can block logins into deactivated tenants.
    const { data: companyUser } = await adminClient
      .from('company_users')
      .select('id, user_id, status, twofa_enabled, failed_login_count, locked_until, must_change_password, companies!inner(status)')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    // Superadmins live in platform_users (never company_users). They share
    // the same auth.users table, so a login by a superadmin returns null
    // above. Fetch the platform_users row too so downstream code knows to
    // prompt for 2FA and apply the same force_2fa_setup redirect.
    const { data: platformUser } = companyUser
      ? { data: null as { twofa_enabled?: boolean } | null }
      : await adminClient
          .from('platform_users')
          .select('twofa_enabled')
          .eq('email', email.toLowerCase())
          .maybeSingle();

    // Block deactivated users + deactivated tenants. S5 enumeration fix:
    // respond with the SAME generic 401 used for bad credentials so an
    // attacker cannot distinguish "wrong password" from "account disabled"
    // or "org disabled". The real reason is logged server-side only.
    if (companyUser?.status === 'inactive') {
      console.log(`[login-gate] Blocked login for deactivated account (company_user ${companyUser.id})`);
      return NextResponse.json(
        { success: false, error: 'Email o contraseña incorrectos.' },
        { status: 401 },
      );
    }
    // companies is an object after `!inner` single-row join, but Supabase
    // types it as array in some versions. Handle both defensively.
    const companiesRel = companyUser?.companies as unknown;
    const companyStatus = Array.isArray(companiesRel)
      ? (companiesRel[0] as { status?: string } | undefined)?.status
      : (companiesRel as { status?: string } | null | undefined)?.status;
    if (companyUser && companyStatus === 'inactive') {
      console.log(`[login-gate] Blocked login into deactivated tenant (company_user ${companyUser.id})`);
      return NextResponse.json(
        { success: false, error: 'Email o contraseña incorrectos.' },
        { status: 401 },
      );
    }

    // Check lockout BEFORE verifying password so we don't leak existence.
    if (companyUser?.locked_until) {
      const lockedUntil = new Date(companyUser.locked_until).getTime();
      if (lockedUntil > Date.now()) {
        return NextResponse.json(
          {
            success: false,
            locked: true,
            error: 'Tu cuenta está bloqueada. Restablece tu contraseña para desbloquearla.',
          },
          { status: 423 },
        );
      }
    }

    // Verify password via temp client (no cookie)
    const tempClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: signInData, error: signInError } =
      await tempClient.auth.signInWithPassword({ email, password });

    // Always sign out the temp client so we don't leave orphan refresh tokens.
    try { await tempClient.auth.signOut(); } catch { /* ignore */ }

    if (signInError || !signInData.user) {
      // Count the failure against the caller's IP (S5). If the IP just hit
      // its cap, answer 429 instead of pushing the account closer to lock.
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

      // Invalid credentials — record a failed attempt if the user exists.
      if (companyUser) {
        const newCount = (companyUser.failed_login_count ?? 0) + 1;
        const shouldLock = newCount >= MAX_ATTEMPTS;
        const update: Record<string, unknown> = { failed_login_count: newCount };
        if (shouldLock) {
          update.locked_until = new Date(Date.now() + LOCK_MS).toISOString();
        }
        await adminClient.from('company_users').update(update).eq('id', companyUser.id);

        if (shouldLock) {
          return NextResponse.json(
            {
              success: false,
              locked: true,
              error: 'Demasiados intentos. Tu cuenta ha sido bloqueada. Restablece tu contraseña.',
            },
            { status: 423 },
          );
        }
        return NextResponse.json(
          {
            success: false,
            error: 'Email o contraseña incorrectos.',
            attemptsLeft: Math.max(0, MAX_ATTEMPTS - newCount),
          },
          { status: 401 },
        );
      }
      // User doesn't exist — generic 401
      return NextResponse.json(
        { success: false, error: 'Email o contraseña incorrectos.' },
        { status: 401 },
      );
    }

    // Successful password check — reset the caller IP's failure counter so
    // legitimate users behind shared NATs don't accumulate stale failures.
    if (ipGate.failedCount > 0) {
      await clearAttempts(adminClient, ipOpts);
    }

    // Password valid. Clear counter/lock; if no 2FA is required, stamp
    // last_login_at now (otherwise verify-2fa will stamp it after the PIN).
    if (companyUser) {
      const update: Record<string, unknown> = {};
      if (companyUser.failed_login_count > 0 || companyUser.locked_until) {
        update.failed_login_count = 0;
        update.locked_until = null;
      }
      if (!companyUser.twofa_enabled) {
        update.last_login_at = new Date().toISOString();
      }
      if (Object.keys(update).length > 0) {
        await adminClient.from('company_users').update(update).eq('id', companyUser.id);
      }
    }

    // needs2fa fires when EITHER table has twofa_enabled. This is the only
    // source of truth the client trusts to decide whether to prompt for
    // the PIN after password success.
    //
    // Dev bypass: when running locally with DEV_SKIP_2FA=true, force
    // needs2fa=false so you can iterate without the PIN dance. Triple-
    // gated (NODE_ENV + env var + separate client hostname check in the
    // layout). Never fires on Vercel deployments.
    const realNeeds2fa = !!(companyUser?.twofa_enabled || platformUser?.twofa_enabled);
    const needs2fa = isDev2faBypassEnabled() ? false : realNeeds2fa;

    return NextResponse.json({
      success: true,
      userId: signInData.user.id,
      needs2fa,
      mustChangePassword: !!companyUser?.must_change_password,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[login-gate] Unhandled error:', message);
    return apiError('auth/login-gate', err, { status: 500 });
  }
}
