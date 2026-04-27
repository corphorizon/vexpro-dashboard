import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// DELETE /api/risk/revisions/[id]
//
// Borra una revisión específica. Cross-tenant guard: verifica que la fila
// pertenezca a la empresa del caller antes de borrar.
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();

    const { data: row } = await admin
      .from('risk_revisions')
      .select('id, company_id')
      .eq('id', id)
      .maybeSingle();

    if (!row) {
      return NextResponse.json(
        { success: false, error: 'Revisión no encontrada' },
        { status: 404 },
      );
    }

    if (row.company_id !== auth.companyId) {
      return NextResponse.json(
        { success: false, error: 'Esta revisión no pertenece a tu empresa' },
        { status: 403 },
      );
    }

    const { error } = await admin
      .from('risk_revisions')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('[risk/revisions DELETE]', error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
