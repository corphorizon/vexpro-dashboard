import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// PATCH /api/superadmin/users/:id
//
// Update a company_users membership (role, name, allowed_modules, status-ish).
// The `id` here is `company_users.id` (not auth user id).
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const body = await request.json();
    const allowed: Record<string, unknown> = {};
    for (const f of ['name', 'role', 'allowed_modules'] as const) {
      if (f in body) allowed[f] = (body as Record<string, unknown>)[f];
    }
    if (Object.keys(allowed).length === 0) {
      return NextResponse.json(
        { success: false, error: 'Ningún campo válido para actualizar' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('company_users')
      .update({ ...allowed, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      return NextResponse.json(
        { success: false, error: error?.message || 'Usuario no encontrado' },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, user: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/superadmin/users/:id
//
// Removes the company_users membership. Does NOT delete the auth.users row,
// because the same person may have memberships in other tenants. If this was
// the user's last membership AND not a superadmin, the auth.user becomes
// orphaned but harmless (they can't log into the dashboard without a profile).
// ---------------------------------------------------------------------------

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();
    const { error } = await admin
      .from('company_users')
      .delete()
      .eq('id', id);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
