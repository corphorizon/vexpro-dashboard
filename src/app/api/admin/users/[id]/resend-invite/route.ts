import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import {
  generateAndSendInvite,
  resolveInviterName,
  originFromRequest,
  ipFromRequest,
} from '@/lib/invite-user';

// ---------------------------------------------------------------------------
// POST /api/admin/users/[id]/resend-invite
//
// Tenant admin re-sends an invitation to a user in their own company.
// Mirrors /api/superadmin/users/[id]/resend-invite but locked to the
// caller's company (no cross-tenant access).
//
// Security:
//   - Requires admin role on the caller's company (verifyAdminAuth).
//   - The target membership must belong to caller.companyId.
//   - Cannot resend invites to users with role='admin' (only superadmin
//     gestiona admins).
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();

    const { data: row, error } = await admin
      .from('company_users')
      .select('id, user_id, email, name, company_id, role')
      .eq('id', id)
      .maybeSingle();

    if (error || !row) {
      return NextResponse.json(
        { success: false, error: 'Usuario no encontrado' },
        { status: 404 },
      );
    }

    // Cross-tenant guard.
    if (row.company_id !== auth.companyId) {
      return NextResponse.json(
        { success: false, error: 'Este usuario no pertenece a tu empresa' },
        { status: 403 },
      );
    }

    // Tenant admins cannot resend invites to other admins.
    if (row.role === 'admin') {
      return NextResponse.json(
        { success: false, error: 'No puedes reenviar invitaciones a otros admins' },
        { status: 403 },
      );
    }

    if (!row.user_id) {
      return NextResponse.json(
        { success: false, error: 'Este usuario no tiene cuenta auth asociada' },
        { status: 400 },
      );
    }

    const { data: companyRow } = await admin
      .from('companies')
      .select('name')
      .eq('id', row.company_id)
      .maybeSingle();
    const companyName = companyRow?.name || 'la empresa';

    const inviterName = await resolveInviterName(admin, auth.userId);

    const result = await generateAndSendInvite({
      admin,
      authUserId: row.user_id,
      recipientEmail: row.email,
      recipientName: row.name,
      inviterName,
      companyId: row.company_id,
      companyName,
      origin: originFromRequest(request),
      createdIp: ipFromRequest(request),
    });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error || 'No se pudo enviar la invitación' },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
