import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { serverAuditLog } from '@/lib/server-audit';

// ---------------------------------------------------------------------------
// POST /api/superadmin/companies/:id/users/:userId/disable-2fa
//
// Clears the user's TOTP state (twofa_secret, twofa_pending_secret,
// twofa_enabled) so they are forced to re-enrol on their next login.
// Use when the user lost access to their authenticator app.
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
      .select('id, email, twofa_enabled')
      .eq('id', userId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json(
        { success: false, error: 'Usuario no encontrado en esta empresa' },
        { status: 404 },
      );
    }

    const { error } = await admin
      .from('company_users')
      .update({
        twofa_enabled: false,
        twofa_secret: null,
        twofa_pending_secret: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId)
      .eq('company_id', companyId);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: auth.name || auth.email,
      action: 'update',
      module: 'users',
      details: `Superadmin desactivó 2FA para ${membership.email} (estaba ${
        membership.twofa_enabled ? 'activo' : 'inactivo'
      })`,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
