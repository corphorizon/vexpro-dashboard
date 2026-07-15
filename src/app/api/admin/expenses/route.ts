import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

// ---------------------------------------------------------------------------
// POST /api/admin/expenses
//
// Reemplazo ATÓMICO de los egresos de un período, del lado del SERVIDOR.
//
// Por qué server-side (2026-07-13): el guardado desde el browser vía el cliente
// supabase-js se colgaba >12s de forma recurrente — el cliente intenta
// refrescar el token de auth antes de cada request y ese refresh se estancaba
// (navigator.locks / red), aunque la DB responde el DELETE+INSERT en ~9ms.
// Moviendo la escritura acá, el browser solo hace un fetch simple con su
// cookie de sesión (sin refresh-token dance); el server valida auth y corre la
// RPC atómica con el admin client. Elimina toda esa clase de cuelgues.
//
// Seguridad: verifyAdminAuth resuelve company_id desde el JWT (nunca del body),
// así que un body forjado no puede escribir en otra empresa. La RPC
// replace_period_expenses omite auth_can_edit solo bajo service_role (ver
// migración replace_period_expenses_service_role_bypass).
// ---------------------------------------------------------------------------

interface ExpenseRow {
  concept: string;
  amount: number;
  paid: number;
  pending: number;
  is_fixed?: boolean;
  category?: string | null;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { periodId, rows } = body as { periodId?: string; rows?: ExpenseRow[] };
    if (!periodId || !Array.isArray(rows)) {
      return NextResponse.json({ error: 'periodId y rows son requeridos' }, { status: 400 });
    }

    const admin = createAdminClient();
    const { error } = await admin.rpc('replace_period_expenses', {
      p_company_id: auth.companyId, // del token, nunca del body
      p_period_id: periodId,
      p_rows: rows.map((e) => ({
        concept: e.concept,
        amount: e.amount,
        paid: e.paid,
        pending: e.pending,
        is_fixed: !!e.is_fixed,
        category: e.category ?? null,
      })),
    });
    if (error) return apiError('admin/expenses', error, { status: 500 });

    // Sync de plantillas de egresos fijos (best-effort, no bloquea la respuesta).
    //
    // Cambio 2026-07-15 (vigencia): antes esto hacía upsert onConflict, que
    // (a) re-activaba una plantilla que el usuario había desactivado, y
    // (b) no seteaba vigencia. Ahora SOLO inserta plantillas NUEVAS con
    // effective_from = año/mes del período que se está guardando — así una
    // plantilla creada en julio no se materializa en meses anteriores. Las
    // plantillas existentes NO se tocan aquí: su amount/active/vigencia se
    // gestionan desde el panel de plantillas, y no queremos que un guardado
    // de egresos las reactive ni pise su fecha.
    const fixedConcepts = rows
      .filter((e) => e.is_fixed && e.concept?.trim())
      .map((e) => ({ concept: e.concept.trim(), amount: e.amount }));

    if (fixedConcepts.length > 0) {
      // Vigencia de las plantillas nuevas = período destino.
      const { data: period } = await admin
        .from('periods')
        .select('year, month')
        .eq('id', periodId)
        .eq('company_id', auth.companyId)
        .maybeSingle();

      // Deduplicar por concepto y filtrar las que ya existen.
      const uniqueByConcept = new Map(fixedConcepts.map((e) => [e.concept, e]));
      const concepts = Array.from(uniqueByConcept.keys());
      const { data: existingTpls } = await admin
        .from('expense_templates')
        .select('concept')
        .eq('company_id', auth.companyId)
        .in('concept', concepts);
      const existing = new Set((existingTpls ?? []).map((t) => t.concept));

      const toInsert = concepts
        .filter((c) => !existing.has(c))
        .map((c) => ({
          company_id: auth.companyId,
          concept: c,
          amount: uniqueByConcept.get(c)!.amount,
          active: true,
          effective_from_year: period?.year ?? null,
          effective_from_month: period?.month ?? null,
        }));

      if (toInsert.length > 0) {
        const { error: tplErr } = await admin.from('expense_templates').insert(toInsert);
        if (tplErr) console.error('[admin/expenses] template insert failed (non-fatal):', tplErr.message);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return apiError('admin/expenses', err, { status: 500 });
  }
}
