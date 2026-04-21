import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomBytes } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendPasswordResetEmail } from '@/services/emailService';
import { checkRateLimit, recordFailure } from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password
//
// Self-service password recovery. Always returns 200 regardless of whether
// the email exists — prevents enumeration.
//
// If the email belongs to a user, we:
//   1. Generate a cryptographically random token
//   2. Store the SHA-256 hash in password_reset_tokens (1 hour TTL)
//   3. Email the user a link containing the raw token
// ---------------------------------------------------------------------------

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Rate-limit: 5 attempts per IP per 10 minutes. Prevents spam (SendGrid
// quota abuse) AND slows brute-force enumeration attempts. Records every
// call, not just failures, because we always return 200 regardless of
// whether the email exists.
const FORGOT_MAX_ATTEMPTS = 5;
const FORGOT_LOCK_MS = 10 * 60 * 1000;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { email } = body as { email?: string };

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ success: false, error: 'email requerido' }, { status: 400 });
    }

    const normalized = email.toLowerCase().trim();
    const adminClient = createAdminClient();

    // Rate limit by caller IP — 5 attempts per 10 min, shared across
    // every email they try. Returns 200 on lockout too, so nothing leaks.
    const callerIp =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown';
    const rlOpts = { key: `ip:${callerIp}`, kind: 'forgot-password' as const };
    const gate = await checkRateLimit(adminClient, rlOpts);
    if (gate.locked) {
      // Still respond 200 to avoid giving the attacker a signal.
      return NextResponse.json({ success: true });
    }
    // Every call counts as a "failure" so the counter advances even when
    // the email doesn't exist.
    await recordFailure(adminClient, {
      ...rlOpts,
      max: FORGOT_MAX_ATTEMPTS,
      lockMs: FORGOT_LOCK_MS,
    });

    // Do not reveal whether the user exists. Look up by email; if absent,
    // return 200 without doing anything.
    const { data: companyUser } = await adminClient
      .from('company_users')
      .select('user_id, name, email, company_id')
      .eq('email', normalized)
      .maybeSingle();

    if (!companyUser) {
      // Intentional no-op to prevent enumeration
      return NextResponse.json({ success: true });
    }

    // Invalidate any previous unused tokens for this user
    await adminClient
      .from('password_reset_tokens')
      .delete()
      .eq('user_id', companyUser.user_id)
      .is('consumed_at', null);

    // Generate token
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

    const { error: insertErr } = await adminClient
      .from('password_reset_tokens')
      .insert({
        user_id: companyUser.user_id,
        token_hash: tokenHash,
        expires_at: expiresAt,
        created_ip:
          request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
          request.headers.get('x-real-ip') ||
          null,
      });

    if (insertErr) {
      console.error('[forgot-password] insert error:', insertErr.message);
      return NextResponse.json({ success: false, error: 'Error interno' }, { status: 500 });
    }

    // Build reset URL
    const origin =
      request.headers.get('origin') ||
      request.headers.get('host')
        ? `${request.headers.get('x-forwarded-proto') || 'https'}://${request.headers.get('host')}`
        : (process.env.NEXT_PUBLIC_APP_URL || 'https://dashboard.horizonconsulting.ai');
    const resetUrl = `${origin}/reset-password?token=${encodeURIComponent(rawToken)}`;

    // Fire-and-forget email send — uses the company's own SendGrid creds if
    // configured, otherwise falls back to env.
    sendPasswordResetEmail(companyUser.email, resetUrl, companyUser.company_id).catch((err) => {
      console.error('[forgot-password] email send failed:', err);
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[forgot-password] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
