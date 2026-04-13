import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import speakeasy from 'speakeasy';

// ---------------------------------------------------------------------------
// POST /api/auth/verify-2fa
//
// Server-side 2FA PIN verification. Receives email + password + pin,
// verifies the PIN against the stored twofa_secret (server-side only),
// and returns whether verification passed. If it did, the client should
// call signInWithPassword again to establish a proper Supabase session.
//
// Rate-limited: max 3 attempts per user, 15-minute lockout.
// ---------------------------------------------------------------------------

const attempts = new Map<string, { count: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 3;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(userId: string): { allowed: boolean; message?: string } {
  const now = Date.now();
  const entry = attempts.get(userId);

  if (entry) {
    if (entry.lockedUntil > now) {
      const minutesLeft = Math.ceil((entry.lockedUntil - now) / 60000);
      return { allowed: false, message: `Cuenta bloqueada. Intenta en ${minutesLeft} minutos.` };
    }
    if (entry.lockedUntil <= now && entry.count >= MAX_ATTEMPTS) {
      // Lockout expired, reset
      attempts.delete(userId);
    }
  }

  return { allowed: true };
}

function recordFailedAttempt(userId: string): void {
  const now = Date.now();
  const entry = attempts.get(userId) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  attempts.set(userId, entry);
}

function clearAttempts(userId: string): void {
  attempts.delete(userId);
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

    const adminClient = createAdminClient();

    // Look up the user's company_users record to get twofa_secret
    // We verify by email — the PIN must match server-side
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

    // Check rate limit
    const rateCheck = checkRateLimit(companyUser.id);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: rateCheck.message },
        { status: 429 },
      );
    }

    // Verify TOTP code server-side using speakeasy
    const isValid = speakeasy.totp.verify({
      secret: companyUser.twofa_secret,
      encoding: 'base32',
      token: pin,
      window: 1, // Accept 1 step before/after (30s tolerance)
    });
    if (!isValid) {
      recordFailedAttempt(companyUser.id);
      const entry = attempts.get(companyUser.id);
      const remaining = MAX_ATTEMPTS - (entry?.count || 0);
      return NextResponse.json(
        {
          success: false,
          error: remaining > 0
            ? `PIN incorrecto. ${remaining} intentos restantes.`
            : 'PIN incorrecto. Cuenta bloqueada por 15 minutos.',
        },
        { status: 401 },
      );
    }

    // PIN is correct — clear rate limit
    clearAttempts(companyUser.id);

    // Verify credentials are still valid by signing in
    // (this ensures the user has valid email/password)
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

    // Sign out the temp client — the real sign-in happens on the browser
    await tempClient.auth.signOut();

    return NextResponse.json({ success: true, verified: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[verify-2fa] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
