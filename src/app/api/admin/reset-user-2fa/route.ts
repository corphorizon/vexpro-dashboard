import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { clearAttempts } from '@/lib/rate-limit';

// ---------------------------------------------------------------------------
// POST /api/admin/reset-user-2fa
//
// Admin-only. Disables 2FA for a target user and clears any pending setup
// secret + rate-limit counters. The user will be prompted to set up 2FA
// again the next time they enter the setup page.
//
// Body: { userId: string }  — the auth user id of the target
//
// Scoped by company_id: an admin can only reset 2FA for users that belong
// to their own company.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json().catch(() => ({}));
    const { userId } = body as { userId?: string };
    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'userId requerido' },
        { status: 400 },
      );
    }

    const adminClient = createAdminClient();

    // Verify the target user is in the caller's company
    const { data: companyUser } = await adminClient
      .from('company_users')
      .select('id, company_id')
      .eq('user_id', userId)
      .eq('company_id', auth.companyId)
      .maybeSingle();

    if (!companyUser) {
      return NextResponse.json(
        { success: false, error: 'Usuario no pertenece a tu empresa' },
        { status: 403 },
      );
    }

    // Disable 2FA and clear any pending setup
    const { error: updateError } = await adminClient
      .from('company_users')
      .update({
        twofa_enabled: false,
        twofa_secret: null,
        twofa_pending_secret: null,
        twofa_pending_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', companyUser.id);

    if (updateError) {
      console.error('[reset-user-2fa] Error:', updateError.message);
      return NextResponse.json(
        { success: false, error: 'Error al resetear 2FA' },
        { status: 500 },
      );
    }

    // Clear any outstanding rate-limit counters for this user
    await clearAttempts(adminClient, { key: companyUser.id, kind: 'verify-2fa' });
    await clearAttempts(adminClient, { key: userId, kind: 'verify-pin' });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[reset-user-2fa] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
