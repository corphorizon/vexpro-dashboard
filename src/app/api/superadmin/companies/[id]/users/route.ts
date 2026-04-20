import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// GET /api/superadmin/companies/:id/users
//
// Returns the full roster of a single tenant with everything the superadmin
// Users panel needs: role, status, allowed_modules, 2FA state, last_login_at.
// Never returns twofa_secret or twofa_pending_secret.
// ---------------------------------------------------------------------------

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id: companyId } = await params;

    const admin = createAdminClient();

    const { data: company } = await admin
      .from('companies')
      .select('id, name, active_modules')
      .eq('id', companyId)
      .maybeSingle();
    if (!company) {
      return NextResponse.json(
        { success: false, error: 'Empresa no encontrada' },
        { status: 404 },
      );
    }

    const { data, error } = await admin
      .from('company_users')
      .select(
        'id, user_id, company_id, email, name, role, status, allowed_modules, twofa_enabled, last_login_at, created_at, updated_at',
      )
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      users: data ?? [],
      company: { id: company.id, name: company.name, active_modules: company.active_modules ?? [] },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
