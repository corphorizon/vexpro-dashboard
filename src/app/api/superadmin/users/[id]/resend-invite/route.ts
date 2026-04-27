import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';
import {
  generateAndSendInvite,
  resolveInviterName,
  originFromRequest,
  ipFromRequest,
} from '@/lib/invite-user';

// ---------------------------------------------------------------------------
// POST /api/superadmin/users/[id]/resend-invite
//
// Regenerates the invite token for a company_users row and sends a fresh
// email. Useful when the original link expired or the user lost the email.
// Logic shared with the admin/users variant via @/lib/invite-user.
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();

    const { data: row, error } = await admin
      .from('company_users')
      .select('id, user_id, email, name, company_id, companies(name)')
      .eq('id', id)
      .maybeSingle();

    if (error || !row) {
      return NextResponse.json(
        { success: false, error: 'Usuario no encontrado' },
        { status: 404 },
      );
    }
    if (!row.user_id) {
      return NextResponse.json(
        { success: false, error: 'Este usuario no tiene cuenta auth asociada' },
        { status: 400 },
      );
    }

    // Supabase types `companies` as object-or-array depending on cardinality.
    const companyJoin = row.companies as { name?: string } | { name?: string }[] | null;
    const companyName = (Array.isArray(companyJoin)
      ? companyJoin[0]?.name
      : companyJoin?.name) || 'la empresa';

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
