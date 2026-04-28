import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// GET /api/admin/ib-rebates/[id]/history
//
// Devuelve el log de cambios de una config IB. Verifica pertenencia al
// company_id antes de exponer el contenido.
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();

    const { data: cfg } = await admin
      .from('ib_rebate_configs')
      .select('company_id')
      .eq('id', id)
      .maybeSingle();
    if (!cfg) {
      return NextResponse.json({ success: false, error: 'No encontrado' }, { status: 404 });
    }
    if (cfg.company_id !== auth.companyId) {
      return NextResponse.json({ success: false, error: 'No autorizado' }, { status: 403 });
    }

    const { data, error } = await admin
      .from('ib_rebate_config_history')
      .select('*')
      .eq('config_id', id)
      .order('created_at', { ascending: false });

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, history: data ?? [] });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Error' },
      { status: 500 },
    );
  }
}
