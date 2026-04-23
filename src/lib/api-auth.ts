import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Roles allowed to call /api/admin/* routes.
const ADMIN_ROLES = ['admin', 'auditor', 'hr'];

export type AuthInfo = {
  userId: string;
  companyId: string;
  role: string;
  name: string;
  email: string;
  /** True when the caller is a platform superadmin acting on a tenant. */
  isSuperadmin?: boolean;
};

/**
 * When the caller is a platform superadmin, company_id can be passed via
 * query string (?company_id=...) or JSON body (company_id). This mirrors
 * the pattern already used by /api/admin/api-credentials and lets superadmins
 * call tenant-scoped endpoints while "viewing as" that tenant.
 *
 * Returns the resolved companyId string or null if not provided.
 */
function readCompanyIdFromRequest(request: NextRequest | undefined): string | null {
  if (!request) return null;
  const q = request.nextUrl.searchParams.get('company_id');
  if (q) return q;
  return null;
}

/**
 * Verify the caller of an /api/admin/* route is authenticated, belongs to a
 * company, and has a privileged role (admin / auditor / hr).
 *
 * Returns the caller's profile on success or an error NextResponse.
 *
 * Platform superadmins are allowed through with `role='admin'` when they
 * target a tenant via ?company_id=<id>. This keeps the "viewing as" flow
 * working for admin-only endpoints (e.g. /api/admin/api-credentials,
 * and the per-provider /api/integrations/<provider>/ping health checks).
 */
export async function verifyAdminAuth(request?: NextRequest): Promise<AuthInfo | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json(
      { success: false, error: 'No autenticado' },
      { status: 401 },
    );
  }

  // Superadmin shortcut — same pattern as verifyAuth.
  const { data: pu } = await supabase
    .from('platform_users')
    .select('id, name, email')
    .eq('user_id', user.id)
    .maybeSingle();

  if (pu) {
    const targetCompanyId = readCompanyIdFromRequest(request);
    if (!targetCompanyId) {
      return NextResponse.json(
        { success: false, error: 'Superadmin debe especificar empresa (?company_id=...)' },
        { status: 400 },
      );
    }
    return {
      userId: user.id,
      companyId: targetCompanyId,
      role: 'admin',
      name: pu.name ?? '',
      email: pu.email ?? user.email ?? '',
      isSuperadmin: true,
    };
  }

  // Fetch the caller's company profile — uses RLS (anon key + cookie JWT),
  // so only rows the user can see are returned.
  const { data: profile } = await supabase
    .from('company_users')
    .select('company_id, role, name, email')
    .eq('user_id', user.id)
    .single();

  if (!profile) {
    return NextResponse.json(
      { success: false, error: 'Usuario sin empresa asignada' },
      { status: 403 },
    );
  }

  if (!ADMIN_ROLES.includes(profile.role)) {
    return NextResponse.json(
      { success: false, error: 'Permiso insuficiente — se requiere rol admin, auditor o hr' },
      { status: 403 },
    );
  }

  return {
    userId: user.id,
    companyId: profile.company_id,
    role: profile.role,
    name: profile.name ?? '',
    email: profile.email ?? user.email ?? '',
  };
}

export type SuperadminAuthInfo = {
  userId: string;
  platformUserId: string;
  name: string;
  email: string;
};

/**
 * Verify the caller of an /api/superadmin/* route is an authenticated
 * Horizon platform superadmin (row in `platform_users`).
 *
 * Returns the caller's platform profile on success or an error NextResponse.
 */
export async function verifySuperadminAuth(): Promise<SuperadminAuthInfo | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json(
      { success: false, error: 'No autenticado' },
      { status: 401 },
    );
  }

  const { data: pu } = await supabase
    .from('platform_users')
    .select('id, name, email')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!pu) {
    return NextResponse.json(
      { success: false, error: 'Acceso restringido — se requiere superadmin' },
      { status: 403 },
    );
  }

  return {
    userId: user.id,
    platformUserId: pu.id,
    name: pu.name ?? '',
    email: pu.email ?? user.email ?? '',
  };
}

/**
 * Verify the caller is authenticated and belongs to a company — any role.
 * Use for read-only endpoints that all company members can access
 * (e.g. movements, balances).
 *
 * When passed a NextRequest, platform superadmins may target any tenant by
 * appending `?company_id=<id>` to the URL. This allows the "viewing as admin"
 * flow in /superadmin to hit tenant-scoped endpoints. Regular users ignore
 * the query param and resolve their company from `company_users` as before.
 */
export async function verifyAuth(request?: NextRequest): Promise<AuthInfo | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json(
      { success: false, error: 'No autenticado' },
      { status: 401 },
    );
  }

  // Superadmin path — no row in company_users, but can target any tenant.
  const { data: pu } = await supabase
    .from('platform_users')
    .select('id, name, email')
    .eq('user_id', user.id)
    .maybeSingle();

  if (pu) {
    const targetCompanyId = readCompanyIdFromRequest(request);
    if (!targetCompanyId) {
      return NextResponse.json(
        { success: false, error: 'Superadmin debe especificar empresa (?company_id=...)' },
        { status: 400 },
      );
    }
    return {
      userId: user.id,
      companyId: targetCompanyId,
      role: 'admin', // superadmin acts with admin privileges inside the target tenant
      name: pu.name ?? '',
      email: pu.email ?? user.email ?? '',
      isSuperadmin: true,
    };
  }

  // Regular user path.
  const { data: profile } = await supabase
    .from('company_users')
    .select('company_id, role, name, email')
    .eq('user_id', user.id)
    .single();

  if (!profile) {
    return NextResponse.json(
      { success: false, error: 'Usuario sin empresa asignada' },
      { status: 403 },
    );
  }

  return {
    userId: user.id,
    companyId: profile.company_id,
    role: profile.role,
    name: profile.name ?? '',
    email: profile.email ?? user.email ?? '',
  };
}
