import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomInt } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { sendTwofaResetCodeEmail } from '@/services/emailService';

// ---------------------------------------------------------------------------
// POST /api/auth/request-2fa-reset
//
// Starts the self-service 2FA reset flow for a user who still remembers their
// password but lost their authenticator. Emails a 6-digit code (15 min TTL).
//
// To prevent abuse:
//   - Always returns 200 regardless of success (prevents enumeration)
//   - Requires valid password (verified via temp client)
//   - Max 1 outstanding code per user (older ones invalidated)
// ---------------------------------------------------------------------------

const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
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

    const normalized = email.toLowerCase().trim();
    const adminClient = createAdminClient();

    const { data: companyUser } = await adminClient
      .from('company_users')
      .select('user_id, name, email, twofa_enabled, company_id')
      .eq('email', normalized)
      .maybeSingle();

    // Neutral response if user doesn't exist or 2FA not enabled
    if (!companyUser || !companyUser.twofa_enabled) {
      return NextResponse.json({ success: true });
    }

    // Verify password via temp client
    const tempClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: signInData, error: signInError } =
      await tempClient.auth.signInWithPassword({ email: normalized, password });
    try { await tempClient.auth.signOut(); } catch { /* ignore */ }

    if (signInError || !signInData.user) {
      // Don't leak that the password was wrong — stay neutral.
      return NextResponse.json({ success: true });
    }

    // Invalidate any outstanding codes for this user
    await adminClient
      .from('twofa_reset_codes')
      .delete()
      .eq('user_id', companyUser.user_id)
      .is('consumed_at', null);

    // Generate a 6-digit numeric code (zero-padded)
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const codeHash = sha256(code);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

    await adminClient.from('twofa_reset_codes').insert({
      user_id: companyUser.user_id,
      code_hash: codeHash,
      expires_at: expiresAt,
    });

    // Fire-and-forget email
    sendTwofaResetCodeEmail({
      to: companyUser.email,
      userName: companyUser.name,
      code,
      expiresInMinutes: 15,
      companyId: companyUser.company_id,
    }).catch((err) => console.error('[request-2fa-reset] email send failed:', err));

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[request-2fa-reset] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
