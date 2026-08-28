// ─────────────────────────────────────────────────────────────────────────────
// GET /api/superadmin/liquidity/accounts/[id]/monthly-pnl
//
// El PnL mes a mes que ya está guardado. NO recalcula: para eso está el
// endpoint de refresh. Una pantalla nunca dispara una consulta a MT5 — el túnel
// cuesta ~3,5 s y sería una conexión al broker por cada visita.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('platform_liquidity_monthly_pnl')
      .select('year, month, pnl, operations_count, is_partial, calculated_at')
      .eq('account_id', id)
      .order('year', { ascending: true })
      .order('month', { ascending: true });
    if (error) return apiError('superadmin/liquidity/monthly-pnl', error, { status: 500 });

    const meses = data ?? [];
    return NextResponse.json({
      success: true,
      months: meses,
      // El total va calculado del lado del servidor para que la tabla y el
      // total no puedan discrepar según quién los sume.
      total: Math.round(meses.reduce((s, m) => s + (Number(m.pnl) || 0), 0) * 100) / 100,
      operations: meses.reduce((s, m) => s + (Number(m.operations_count) || 0), 0),
    });
  } catch (err) {
    return apiError('superadmin/liquidity/monthly-pnl', err, { status: 500 });
  }
}
