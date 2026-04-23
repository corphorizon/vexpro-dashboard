import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// PATCH /api/superadmin/companies/:id
//
// Update a tenant's editable fields. Whitelist of fields kept tight — name,
// logo, colors, modules, status. Slug and subdomain are NOT mutable here to
// avoid breaking bookmarks / integrations.
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
    const FIELDS = [
      'name', 'logo_url', 'logo_url_white', 'color_primary', 'color_secondary',
      'active_modules', 'reserve_pct', 'currency', 'status',
      'default_wallet_id',
    ] as const;
    for (const f of FIELDS) {
      if (f in body) allowed[f] = (body as Record<string, unknown>)[f];
    }

    if (Object.keys(allowed).length === 0) {
      return NextResponse.json(
        { success: false, error: 'Ningún campo válido para actualizar' },
        { status: 400 },
      );
    }

    if (allowed.status && !['active', 'inactive'].includes(allowed.status as string)) {
      return NextResponse.json(
        { success: false, error: 'status debe ser active o inactive' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('companies')
      .update({ ...allowed, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      return NextResponse.json(
        { success: false, error: error?.message || 'No se encontró la entidad' },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, company: data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
