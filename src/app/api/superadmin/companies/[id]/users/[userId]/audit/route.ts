import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

// ---------------------------------------------------------------------------
// GET /api/superadmin/companies/:id/users/:userId/audit?limit=5
//
// Returns the most recent audit entries for a specific user within a tenant.
// Matches by auth user_id (stored as TEXT in audit_logs.user_id). Scoped by
// company_id so we don't leak entries from other tenants the same auth user
// may be a member of.
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id: companyId, userId } = await params;

    const limit = Math.min(
      parseInt(request.nextUrl.searchParams.get('limit') || '5', 10) || 5,
      100,
    );

    const admin = createAdminClient();

    const { data: membership } = await admin
      .from('company_users')
      .select('user_id, email')
      .eq('id', userId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json(
        { success: false, error: 'Usuario no encontrado en esta empresa' },
        { status: 404 },
      );
    }

    const { data, error } = await admin
      .from('audit_logs')
      .select('id, action, module, details, created_at, user_name')
      .eq('company_id', companyId)
      .eq('user_id', membership.user_id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      return apiError('superadmin/companies/[id]/users/[userId]/audit', error, { status: 500 });
    }

    return NextResponse.json({ success: true, entries: data ?? [] });
  } catch (err) {
    return apiError('superadmin/companies/[id]/users/[userId]/audit', err, { status: 500 });
  }
}
