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
