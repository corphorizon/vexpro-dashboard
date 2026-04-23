import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// POST /api/admin/reset-password
//
// Resets a user's password by email. Uses service_role key so the admin
// can reset any user's password without knowing the current one.
// Scoped to the caller's company — cannot reset passwords cross-tenant.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { email, newPassword } = body as {
      email?: string;
      newPassword?: string;
    };

    if (!email || !newPassword) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: email, newPassword' },
        { status: 400 },
      );
    }

    const adminClient = createAdminClient();

    // Verify the email belongs to a user in the caller's company
    const { data: companyUser } = await adminClient
      .from('company_users')
      .select('user_id')
      .eq('email', email)
      .eq('company_id', auth.companyId)
      .maybeSingle();

    if (!companyUser) {
      return NextResponse.json(
        { success: false, error: 'Usuario no encontrado en tu empresa' },
        { status: 403 },
      );
    }

    if (!companyUser.user_id) {
      return NextResponse.json(
        { success: false, error: 'Usuario no tiene cuenta de autenticación asociada' },
        { status: 404 },
      );
    }

    // Update the password using the verified user_id
    const { error: updateError } = await adminClient.auth.admin.updateUserById(
      companyUser.user_id,
      { password: newPassword },
    );

    if (updateError) {
      console.error('[AdminAPI] Error resetting password:', updateError.message);
      return NextResponse.json(
        { success: false, error: updateError.message },
        { status: 500 },
      );
    }

    console.log(`[AdminAPI] Password reset for user_id: ${companyUser.user_id}`);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[AdminAPI] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
