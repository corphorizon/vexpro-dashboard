import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, recordFailure, clearAttempts } from '@/lib/rate-limit';
import speakeasy from 'speakeasy';

// ---------------------------------------------------------------------------
// POST /api/auth/verify-pin
//
// Server-side verification of a user's 2FA PIN (e.g. for deactivation or
// gated actions). Requires an active Supabase session. Verifies the PIN
// against the stored twofa_secret without ever sending it to the client.
//
// Rate-limited (3 failed attempts → 15 min lockout, tracked per user_id in
// the twofa_attempts Supabase table — durable across serverless workers).
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const LOCK_MS = 15 * 60 * 1000;

export async function POST(request: NextRequest) {
  try {
    // Verify the caller has an active session
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { success: false, error: 'No autenticado' },
        { status: 401 },
      );
    }

    const body = await request.json();
    const { pin } = body as { pin?: string };

    // Validate format up-front (6 numeric digits)
    if (!pin || !/^\d{6}$/.test(pin)) {
      return NextResponse.json(
        { success: false, error: 'Se requiere un PIN de 6 dígitos' },
        { status: 400 },
      );
    }

    const adminClient = createAdminClient();
    const rlOpts = { key: user.id, kind: 'verify-pin' as const };

    // Check rate-limit
    const gate = await checkRateLimit(adminClient, rlOpts);
    if (gate.locked) {
      const minutes = Math.ceil(gate.waitMs / 60000);
      return NextResponse.json(
        {
          success: false,
          error: `Demasiados intentos. Intenta de nuevo en ${minutes} minuto${minutes === 1 ? '' : 's'}.`,
          locked: true,
          waitMs: gate.waitMs,
        },
        { status: 429 },
      );
    }

    // Look up the stored secret using admin client (server-side only)
    const { data: companyUser } = await adminClient
      .from('company_users')
      .select('twofa_secret')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!companyUser || !companyUser.twofa_secret) {
      return NextResponse.json(
        { success: false, error: '2FA no configurado' },
        { status: 400 },
      );
    }

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
      return NextResponse.json(
        {
          success: false,
          error: next.locked
            ? 'Demasiados intentos. Cuenta bloqueada 15 minutos.'
            : 'Código incorrecto',
          locked: next.locked,
          attemptsLeft: Math.max(0, MAX_ATTEMPTS - next.failedCount),
        },
        { status: next.locked ? 429 : 401 },
      );
    }

    // Success → clear any prior failures
    await clearAttempts(adminClient, rlOpts);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
