import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { clearAttempts } from '@/lib/rate-limit';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import { notify } from '@/lib/notifications/notify';
import { guardAdminTarget } from '@/lib/admin-user-guards';

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
    const auth = await verifyAdminAuth(request, { requireAdmin: true });
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
      .select('id, company_id, name, email, role')
      .eq('user_id', userId)
      .eq('company_id', auth.companyId)
      .maybeSingle();

    if (!companyUser) {
      return NextResponse.json(
        { success: false, error: 'Usuario no pertenece a tu empresa' },
        { status: 403 },
      );
    }

    // Desactivar el 2FA de OTRO admin lo dejaría abierto a una toma de cuenta
    // por un par: solo el superadmin puede resetear el 2FA de un admin.
    const targetGuard = guardAdminTarget(companyUser.role, auth);
    if (targetGuard) return targetGuard;

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

    // Desactivar el segundo factor de otro usuario es la operación con la que
    // se toma una cuenta ajena; hasta ahora no dejaba ninguna traza.
    const actor = auth.name || auth.email;
    const target = companyUser.name || companyUser.email || userId;

    await serverAuditLog(adminClient, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: actor,
      action: 'update',
      module: 'users',
      details: `2FA reseteado para ${target}`,
    });

    void notify(adminClient, {
      companyId: auth.companyId,
      type: 'security.twofa_reset',
      params: { actor, target },
      link: '/usuarios',
      excludeUserIds: [auth.userId],
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[reset-user-2fa] Unhandled error:', message);
    return apiError('admin/reset-user-2fa', err, { status: 500 });
  }
}
