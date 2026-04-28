import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { logIbRebateHistory } from '../_history';

// ---------------------------------------------------------------------------
// PATCH /api/admin/ib-rebates/[id]
//
// Tres caminos según `changeType` en el body:
//   · 'goals_met' → toggle del flag (no resetea fecha, no edita niveles)
//   · 'edit' / 'upgrade' / 'downgrade' → reescribe niveles + resetea
//     config_date a hoy + setea last_change_type
//
// 'edit' se trata como modo inicial en alertas (no penaliza arreglos
// menores). 'upgrade'/'downgrade' activan modo recurrente (alertas más
// frecuentes — 30/60/90 vs 60/90).
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const body = await request.json();
    const { changeType = 'edit' } = body as {
      changeType?: 'edit' | 'upgrade' | 'downgrade' | 'goals_met';
    };

    const admin = createAdminClient();

    const { data: existing } = await admin
      .from('ib_rebate_configs')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Configuración no encontrada' },
        { status: 404 },
      );
    }
    if (existing.company_id !== auth.companyId) {
      return NextResponse.json(
        { success: false, error: 'No autorizado' },
        { status: 403 },
      );
    }

    const update: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
      updated_by: auth.userId,
    };

    if (changeType === 'goals_met') {
      update.goals_met = !existing.goals_met;
    } else {
      const allowedFields = [
        'username', 'archivo',
        'stp', 'ecn', 'cent', 'pro', 'vip', 'elite',
        'syntheticos_level', 'propfirm_level', 'notes',
      ];
      for (const f of allowedFields) {
        if (f in body) update[f] = body[f];
      }
      // edit/upgrade/downgrade resetean `last_update_date` (y la legacy
      // `config_date`) a hoy. `original_config_date` queda intacta como
      // referencia histórica del primer setup.
      const today = new Date().toISOString().slice(0, 10);
      update.last_update_date = today;
      update.config_date = today; // legacy, sincronizada con last_update
      update.last_change_type =
        changeType === 'upgrade' ? 'upgrade'
        : changeType === 'downgrade' ? 'downgrade'
        : 'edit';
    }

    const { data: updated, error: updateErr } = await admin
      .from('ib_rebate_configs')
      .update(update)
      .eq('id', id)
      .select()
      .single();

    if (updateErr || !updated) {
      return NextResponse.json(
        { success: false, error: updateErr?.message || 'Error al actualizar' },
        { status: 500 },
      );
    }

    await logIbRebateHistory(admin, {
      configId: id,
      companyId: auth.companyId,
      changeType,
      snapshot: updated,
      changedBy: auth.userId,
      notes: typeof body.notes_for_history === 'string' ? body.notes_for_history : null,
    });

    return NextResponse.json({ success: true, config: updated });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Error' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();
    const { data: existing } = await admin
      .from('ib_rebate_configs')
      .select('id, company_id')
      .eq('id', id)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ success: false, error: 'No encontrado' }, { status: 404 });
    }
    if (existing.company_id !== auth.companyId) {
      return NextResponse.json({ success: false, error: 'No autorizado' }, { status: 403 });
    }

    const { error } = await admin.from('ib_rebate_configs').delete().eq('id', id);
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Error' },
      { status: 500 },
    );
  }
}
