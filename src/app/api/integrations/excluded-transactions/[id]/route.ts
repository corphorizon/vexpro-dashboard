import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

// ---------------------------------------------------------------------------
// DELETE /api/integrations/excluded-transactions/[id]
//
// Quita la marca de excluida (la transacción vuelve a contar en totales y
// reaparece en la tabla). Solo admin/socio. Cross-tenant guard antes del
// delete.
// ---------------------------------------------------------------------------

const ALLOWED_ROLES = ['admin', 'socio'];

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    // Mismo criterio que el POST: superadmins también pueden quitar la
    // exclusión cuando operan en modo "viewing as".
    if (!ALLOWED_ROLES.includes(auth.role ?? '') && auth.isSuperadmin !== true) {
      return NextResponse.json(
        { success: false, error: 'Solo admin, socios o superadmin pueden quitar exclusiones' },
        { status: 403 },
      );
    }

    const { id } = await params;
    const admin = createAdminClient();

    const { data: row } = await admin
      .from('excluded_transactions')
      .select('id, company_id')
      .eq('id', id)
      .maybeSingle();

    if (!row) {
      return NextResponse.json(
        { success: false, error: 'Exclusión no encontrada' },
        { status: 404 },
      );
    }
    if (row.company_id !== auth.companyId) {
      return NextResponse.json(
        { success: false, error: 'No autorizado' },
        { status: 403 },
      );
    }

    const { error } = await admin
      .from('excluded_transactions')
      .delete()
      .eq('id', id);

    if (error) {
      return apiError('integrations/excluded-transactions/[id]', error, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return apiError('integrations/excluded-transactions/[id]', err, { status: 500 });
  }
}
