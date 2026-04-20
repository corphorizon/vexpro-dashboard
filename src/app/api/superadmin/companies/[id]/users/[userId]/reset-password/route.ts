import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { serverAuditLog } from '@/lib/server-audit';

// ---------------------------------------------------------------------------
// POST /api/superadmin/companies/:id/users/:userId/reset-password
//
// Sends a password-recovery email to the target user via Supabase Admin API.
// Leaves the account unlocked (recovery email overrides the lockout because
// users are expected to reset their password after the 3-attempt lockout).
// ---------------------------------------------------------------------------

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id: companyId, userId } = await params;

    const admin = createAdminClient();

    const { data: membership } = await admin
      .from('company_users')
      .select('id, user_id, email, name')
      .eq('id', userId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json(
        { success: false, error: 'Usuario no encontrado en esta empresa' },
        { status: 404 },
      );
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://dashboard.horizonconsulting.ai';
    const redirectTo = `${appUrl.replace(/\/$/, '')}/reset-password`;

    const { error } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: membership.email,
      options: { redirectTo },
    });

    if (error) {
      return NextResponse.json(
        { success: false, error: `No se pudo generar el enlace: ${error.message}` },
        { status: 500 },
      );
    }

    // Also clear lockout so the user can log in after resetting.
    await admin
      .from('company_users')
      .update({ failed_login_count: 0, locked_until: null })
      .eq('id', userId);

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: auth.name || auth.email,
      action: 'update',
      module: 'users',
      details: `Superadmin envió email de reset de contraseña a ${membership.email}`,
    });

    return NextResponse.json({ success: true, sent_to: membership.email });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
