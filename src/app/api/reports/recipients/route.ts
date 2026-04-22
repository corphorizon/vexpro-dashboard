// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reports/recipients
//
// Returns the list of users of the caller's company that could receive a
// report email — i.e. have 'reports' in allowed_modules, are active, and
// have a non-empty email. Used by the "Enviar Reporte" modal on
// /finanzas/reportes.
//
// Admin-only (verifyAdminAuth with role=admin).
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(request: NextRequest) {
  const explicit = request.nextUrl.searchParams.get('company_id');

  let companyId: string;
  if (explicit) {
    const sa = await verifySuperadminAuth();
    if (sa instanceof NextResponse) return sa;
    companyId = explicit;
  } else {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;
    if (auth.role !== 'admin') {
      return NextResponse.json(
        { success: false, error: 'Solo administradores' },
        { status: 403 },
      );
    }
    companyId = auth.companyId;
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('company_users')
    .select('id, email, name, role, allowed_modules, status')
    .eq('company_id', companyId);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{
    id: string;
    email: string | null;
    name: string | null;
    role: string;
    allowed_modules: string[] | null;
    status: string | null;
  }>;

  // Anyone who can see any part of Finanzas (reports OR movements) is a
  // candidate. Admins are always included regardless of allowed_modules.
  const FINANZAS_MODULES = ['reports', 'movements'];
  const recipients = rows
    .filter((r) => r.status !== 'inactive' && r.email)
    .filter(
      (r) =>
        r.role === 'admin' ||
        (Array.isArray(r.allowed_modules) &&
          r.allowed_modules.some((m) => FINANZAS_MODULES.includes(m))),
    )
    .map((r) => ({
      id: r.id,
      email: r.email!,
      name: r.name ?? r.email!,
      role: r.role,
    }));

  return NextResponse.json({ success: true, recipients });
}
