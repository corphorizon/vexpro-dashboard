import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { logIbRebateHistory } from './_history';

// ---------------------------------------------------------------------------
// /api/admin/ib-rebates — listado y creación de configs IB scopeadas por
// company_id. RLS bypass via admin client (verifyAdminAuth ya valida que el
// caller es admin/auditor/hr o un superadmin con ?company_id=...).
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('ib_rebate_configs')
      .select('*')
      .eq('company_id', auth.companyId)
      .order('config_date', { ascending: false });

    if (error) {
      console.error('[ib-rebates GET]', error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, configs: data ?? [] });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Error' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const {
      username, archivo, config_date,
      stp, ecn, cent, pro, vip, elite,
      syntheticos_level, propfirm_level, notes,
    } = body as Record<string, unknown>;

    if (!username || typeof username !== 'string' || !config_date) {
      return NextResponse.json(
        { success: false, error: 'username y config_date son requeridos' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    // Duplicado por username (case-insensitive) dentro de la misma empresa.
    const { data: dupe } = await admin
      .from('ib_rebate_configs')
      .select('id, username')
      .eq('company_id', auth.companyId)
      .ilike('username', username.trim())
      .maybeSingle();
    if (dupe) {
      return NextResponse.json(
        { success: false, error: `Ya existe una configuración para ${dupe.username}` },
        { status: 409 },
      );
    }

    const { data: created, error: insertErr } = await admin
      .from('ib_rebate_configs')
      .insert({
        company_id: auth.companyId,
        username: username.trim(),
        archivo: (archivo as string | null) || null,
        // En creación las 3 fechas arrancan iguales (la del form). El
        // historial divergerá en cada PATCH posterior: `original_config_date`
        // queda fija; `last_update_date` (y la legacy `config_date`) se
        // resetean a hoy.
        config_date,
        original_config_date: config_date,
        last_update_date: config_date,
        stp: Number(stp) || 0,
        ecn: Number(ecn) || 0,
        cent: Number(cent) || 0,
        pro: Number(pro) || 0,
        vip: Number(vip) || 0,
        elite: Number(elite) || 0,
        syntheticos_level: Number(syntheticos_level) || 0,
        propfirm_level: Number(propfirm_level) || 0,
        notes: (notes as string | null) || null,
        goals_met: false,
        last_change_type: null,
        created_by: auth.userId,
        updated_by: auth.userId,
      })
      .select()
      .single();

    if (insertErr || !created) {
      console.error('[ib-rebates POST]', insertErr?.message);
      return NextResponse.json(
        { success: false, error: insertErr?.message || 'Error al crear' },
        { status: 500 },
      );
    }

    await logIbRebateHistory(admin, {
      configId: created.id,
      companyId: auth.companyId,
      changeType: 'create',
      snapshot: created,
      changedBy: auth.userId,
    });

    return NextResponse.json({ success: true, config: created });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Error' },
      { status: 500 },
    );
  }
}
