import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Roles allowed to call /api/admin/* routes.
const ADMIN_ROLES = ['admin', 'auditor', 'hr'];

export type AuthInfo = {
  userId: string;
  companyId: string;
  role: string;
  name: string;
  email: string;
};

/**
 * Verify the caller of an /api/admin/* route is authenticated, belongs to a
 * company, and has a privileged role (admin / auditor / hr).
 *
 * Returns the caller's profile on success or an error NextResponse.
 */
export async function verifyAdminAuth(): Promise<AuthInfo | NextResponse> {
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
 */
export async function verifyAuth(): Promise<AuthInfo | NextResponse> {
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
