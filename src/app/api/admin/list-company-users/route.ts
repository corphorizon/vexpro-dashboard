import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// GET /api/admin/list-company-users
//
// Returns the company_users for the caller's tenant with effective_role
// resolved (custom roles → base_role). Bypasses RLS via the admin client so
// platform superadmins viewing-as a tenant — who have no row in that
// tenant's company_users — can still read the member list.
//
// Auth: verifyAdminAuth covers both paths
//   · tenant admin/auditor/hr → companyId from JWT
//   · superadmin              → companyId from ?company_id=<uuid>
//
// Response shape mirrors `User` in src/lib/auth-context.tsx so the client
// can drop the result straight into state. `twofa_secret` is never selected.
// ---------------------------------------------------------------------------

const BUILT_IN_ROLES = ['admin', 'socio', 'auditor', 'soporte', 'hr', 'invitado'];

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAuth(request);
  if (auth instanceof NextResponse) return auth;

  const admin = createAdminClient();

  const { data: rawUsers, error: uErr } = await admin
    .from('company_users')
    .select('id, user_id, email, name, role, company_id, allowed_modules, twofa_enabled, force_2fa_setup, must_change_password')
    .eq('company_id', auth.companyId);

  if (uErr) {
    console.error('[admin/list-company-users] users query failed:', uErr.message);
    return NextResponse.json({ success: false, error: uErr.message }, { status: 500 });
  }

  const { data: customRoles } = await admin
    .from('custom_roles')
    .select('name, base_role')
    .eq('company_id', auth.companyId);

  const customMap = new Map<string, string>(
    (customRoles || []).map((r) => [r.name as string, r.base_role as string]),
  );

  const users = (rawUsers || []).map((u: Record<string, unknown>) => {
    const roleStr = u.role as string;
    const effective_role = BUILT_IN_ROLES.includes(roleStr)
      ? roleStr
      : (customMap.get(roleStr) ?? 'invitado');
    return {
      id: u.id as string,
      auth_user_id: u.user_id as string,
      email: u.email as string,
      name: u.name as string,
      role: roleStr,
      effective_role,
      company_id: u.company_id as string,
      allowed_modules: (u.allowed_modules as string[]) || [],
      twofa_enabled: (u.twofa_enabled as boolean) || false,
      force_2fa_setup: (u.force_2fa_setup as boolean) ?? true,
      must_change_password: (u.must_change_password as boolean) ?? false,
      is_superadmin: false,
    };
  });

  return NextResponse.json({ success: true, users });
}
