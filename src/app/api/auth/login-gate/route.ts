import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

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

    // Look up user state. Avoid leaking existence details: we respond with a
    // generic "credentials invalid" if the account doesn't exist.
    // Join companies.status so we can block logins into deactivated tenants.
    const { data: companyUser } = await adminClient
      .from('company_users')
      .select('id, user_id, status, twofa_enabled, failed_login_count, locked_until, must_change_password, companies!inner(status)')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    // Block deactivated users + deactivated tenants. Both checks use 403
    // with a vague message — we don't want to tell attackers "this email
    // exists but is disabled" either, so we apply them AFTER the password
    // lookup would have succeeded? No — we apply them early because the
    // deactivation is a hard stop and leaking "account disabled" vs
    // "wrong password" is acceptable here (the user knows they were active
    // yesterday; the admin told them they're off).
    if (companyUser?.status === 'inactive') {
      return NextResponse.json(
        { success: false, error: 'Tu cuenta está desactivada. Contacta al administrador.' },
        { status: 403 },
      );
    }
    // companies is an object after `!inner` single-row join, but Supabase
    // types it as array in some versions. Handle both defensively.
    const companiesRel = companyUser?.companies as unknown;
    const companyStatus = Array.isArray(companiesRel)
      ? (companiesRel[0] as { status?: string } | undefined)?.status
      : (companiesRel as { status?: string } | null | undefined)?.status;
    if (companyUser && companyStatus === 'inactive') {
      return NextResponse.json(
        { success: false, error: 'Tu organización está desactivada. Contacta al administrador.' },
        { status: 403 },
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
            error: 'Credenciales inválidas',
            attemptsLeft: Math.max(0, MAX_ATTEMPTS - newCount),
          },
          { status: 401 },
        );
      }
      // User doesn't exist — generic 401
      return NextResponse.json(
        { success: false, error: 'Credenciales inválidas' },
        { status: 401 },
      );
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

    return NextResponse.json({
      success: true,
      userId: signInData.user.id,
      needs2fa: !!companyUser?.twofa_enabled,
      mustChangePassword: !!companyUser?.must_change_password,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[login-gate] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
