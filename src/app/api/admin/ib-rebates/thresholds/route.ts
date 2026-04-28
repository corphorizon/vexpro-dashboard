import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { DEFAULT_THRESHOLDS } from '@/lib/ib-rebates/types';

// ---------------------------------------------------------------------------
// /api/admin/ib-rebates/thresholds — umbrales de alerta por empresa.
// GET devuelve la fila de la empresa o los defaults si nunca se configuró.
// PUT hace upsert validando que initial_yellow < initial_red y que
// recurring_yellow < recurring_orange < recurring_red.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const { data } = await admin
      .from('ib_rebate_thresholds')
      .select('*')
      .eq('company_id', auth.companyId)
      .maybeSingle();

    if (data) {
      return NextResponse.json({ success: true, thresholds: data });
    }

    return NextResponse.json({
      success: true,
      thresholds: { company_id: auth.companyId, ...DEFAULT_THRESHOLDS },
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Error' },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const {
      initial_yellow_days,
      initial_red_days,
      recurring_yellow_days,
      recurring_orange_days,
      recurring_red_days,
    } = body as Record<string, number>;

    const allNumbers = [
      initial_yellow_days, initial_red_days,
      recurring_yellow_days, recurring_orange_days, recurring_red_days,
    ];
    if (allNumbers.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
      return NextResponse.json(
        { success: false, error: 'Todos los umbrales deben ser números >= 0' },
        { status: 400 },
      );
    }

    if (initial_yellow_days >= initial_red_days) {
      return NextResponse.json(
        { success: false, error: 'Días amarillo debe ser menor que rojo (inicial)' },
        { status: 400 },
      );
    }
    if (
      recurring_yellow_days >= recurring_orange_days ||
      recurring_orange_days >= recurring_red_days
    ) {
      return NextResponse.json(
        { success: false, error: 'Días recurrentes mal ordenados (yellow < orange < red)' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    const { data, error } = await admin
      .from('ib_rebate_thresholds')
      .upsert({
        company_id: auth.companyId,
        initial_yellow_days,
        initial_red_days,
        recurring_yellow_days,
        recurring_orange_days,
        recurring_red_days,
        updated_at: new Date().toISOString(),
        updated_by: auth.userId,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, thresholds: data });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Error' },
      { status: 500 },
    );
  }
}
