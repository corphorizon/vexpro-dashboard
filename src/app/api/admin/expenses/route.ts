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
    const fixed = rows
      .filter((e) => e.is_fixed && e.concept?.trim())
      .map((e) => ({
        company_id: auth.companyId,
        concept: e.concept,
        amount: e.amount,
        active: true,
      }));
    if (fixed.length > 0) {
      const { error: tplErr } = await admin
        .from('expense_templates')
        .upsert(fixed, { onConflict: 'company_id,concept' });
      if (tplErr) console.error('[admin/expenses] template sync failed (non-fatal):', tplErr.message);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return apiError('admin/expenses', err, { status: 500 });
  }
}
