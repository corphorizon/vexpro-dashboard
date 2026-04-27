import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// /api/risk/revisions — historial persistente de Revisión Retiros PropFirm.
//
// Reemplaza el localStorage anterior (`risk_propfirm_history`). Cada fila
// guarda el HistoryRecord serializado en `payload` (jsonb), scopeado por
// `company_id` para que todos los usuarios de la misma empresa compartan
// el historial. Tope MAX_REVISIONS por empresa — al pasarse, se borran las
// más viejas para mantener el cap.
// ---------------------------------------------------------------------------

const MAX_REVISIONS = 50;

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();

    const { data, error } = await admin
      .from('risk_revisions')
      .select('id, payload, created_at')
      .eq('company_id', auth.companyId)
      .order('created_at', { ascending: false })
      .limit(MAX_REVISIONS);

    if (error) {
      console.error('[risk/revisions GET]', error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, revisions: data ?? [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { payload } = body as { payload?: unknown };

    if (!payload || typeof payload !== 'object') {
      return NextResponse.json(
        { success: false, error: 'payload requerido' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    const { data: inserted, error: insertErr } = await admin
      .from('risk_revisions')
      .insert({
        company_id: auth.companyId,
        created_by: auth.userId,
        payload,
      })
      .select('id, payload, created_at')
      .single();

    if (insertErr || !inserted) {
      console.error('[risk/revisions POST]', insertErr?.message);
      return NextResponse.json(
        { success: false, error: insertErr?.message || 'No se pudo guardar' },
        { status: 500 },
      );
    }

    // Cap al historial: borrar lo que sobrepase MAX_REVISIONS por empresa.
    const { data: extras } = await admin
      .from('risk_revisions')
      .select('id')
      .eq('company_id', auth.companyId)
      .order('created_at', { ascending: false })
      .range(MAX_REVISIONS, MAX_REVISIONS + 100);

    if (extras && extras.length > 0) {
      await admin
        .from('risk_revisions')
        .delete()
        .in('id', extras.map((e) => e.id));
    }

    return NextResponse.json({ success: true, revision: inserted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
