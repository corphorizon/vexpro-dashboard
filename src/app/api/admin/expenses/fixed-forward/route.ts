import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

// ---------------------------------------------------------------------------
// POST /api/admin/expenses/fixed-forward
//
// Edición de un EGRESO FIJO con efecto "de este mes en adelante".
//
// Kevin (2026-08-06): "en egresos, los que son egresos fijos que dejen
// editarse y que al editarse cambien de ese mes en adelante".
//
// Semántica:
//   apply = 'this'    → solo la fila de ESTE período (el guardado normal ya lo
//                       hizo; acá se re-aplica por si el endpoint se usa suelto).
//   apply = 'forward' → este período + la PLANTILLA + los meses FUTUROS ya
//                       materializados. Los meses ANTERIORES nunca se tocan:
//                       sus cifras ya se reportaron.
//
// CLAVE DE MATCHING = EL CONCEPTO VIEJO. `expenses` NO tiene template_id: la
// materialización de fijos empareja plantilla↔egreso por `concept` (ver
// materialize_fixed_expenses, migration-050). Por eso el body manda
// `old_concept` además del nuevo: si el usuario renombró el egreso, el viejo
// es lo único que identifica las filas y la plantilla a actualizar.
//
// Seguridad: mismo patrón que /api/admin/expenses — verifyAdminAuth resuelve
// company_id desde el JWT (nunca del body) y TODAS las queries filtran por él
// con el admin client.
//
// Atomicidad: son varios UPDATE con el cliente admin, no una transacción de DB.
// El orden está elegido para que un fallo a mitad deje datos legibles y el
// reintento sea idempotente (todos los UPDATE son "poner este valor", no
// incrementos): 1) este mes, 2) plantilla, 3) meses futuros.
// ---------------------------------------------------------------------------

interface Body {
  period_id?: string;
  old_concept?: string;
  concept?: string;
  amount?: number;
  category?: string | null;
  apply?: 'this' | 'forward';
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json()) as Body;
    const periodId = body.period_id;
    const oldConcept = (body.old_concept ?? '').trim();
    const concept = (body.concept ?? '').trim();
    const amount = Number(body.amount);
    const category = body.category ?? null;
    const apply = body.apply === 'this' ? 'this' : 'forward';

    if (!periodId || !oldConcept || !concept) {
      return NextResponse.json(
        { error: 'period_id, old_concept y concept son requeridos' },
        { status: 400 },
      );
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: 'Monto inválido' }, { status: 400 });
    }

    const admin = createAdminClient();
    const now = new Date().toISOString();

    // Año/mes del período de referencia. Filtrado por company_id: un period_id
    // de otra empresa simplemente no existe para este caller.
    const { data: period, error: perErr } = await admin
      .from('periods')
      .select('year, month')
      .eq('id', periodId)
      .eq('company_id', auth.companyId)
      .maybeSingle();
    if (perErr) return apiError('admin/expenses/fixed-forward period', perErr, { status: 500 });
    if (!period) return NextResponse.json({ error: 'Período no encontrado' }, { status: 404 });

    // ── (a) Este período ──
    // Solo concepto/monto/categoría: paid y pending de ESTE mes son del
    // usuario (los acaba de editar en pantalla) y no se pisan.
    const { error: thisErr } = await admin
      .from('expenses')
      .update({ concept, amount, category, updated_at: now })
      .eq('company_id', auth.companyId)
      .eq('period_id', periodId)
      .eq('is_fixed', true)
      .eq('concept', oldConcept);
    if (thisErr) return apiError('admin/expenses/fixed-forward this', thisErr, { status: 500 });

    if (apply === 'this') {
      return NextResponse.json({ success: true, updatedPeriods: 0 });
    }

    // ── (b) La plantilla ──
    // Para que las materializaciones FUTURAS (períodos aún no creados) usen ya
    // el concepto y el monto nuevos. Match por concepto viejo, company-scoped.
    const { error: tplErr } = await admin
      .from('expense_templates')
      .update({ concept, amount })
      .eq('company_id', auth.companyId)
      .eq('concept', oldConcept);
    if (tplErr) return apiError('admin/expenses/fixed-forward template', tplErr, { status: 500 });

    // ── (c) Meses FUTUROS ya materializados ──
    // (year, month) estrictamente mayor al período de referencia. Los
    // anteriores quedan intactos por construcción: nunca entran a esta lista.
    const { data: futurePeriods, error: fpErr } = await admin
      .from('periods')
      .select('id, year, month')
      .eq('company_id', auth.companyId)
      .or(`year.gt.${period.year},and(year.eq.${period.year},month.gt.${period.month})`);
    if (fpErr) return apiError('admin/expenses/fixed-forward periods', fpErr, { status: 500 });

    const futureIds = (futurePeriods ?? []).map((p) => p.id);
    if (futureIds.length === 0) {
      return NextResponse.json({ success: true, updatedPeriods: 0 });
    }

    // Se leen las filas primero porque `pending` depende de `paid`, que varía
    // fila a fila: pending = max(amount − paid, 0). Si en un mes futuro ya
    // había un pago parcial registrado, se respeta.
    const { data: futureRows, error: frErr } = await admin
      .from('expenses')
      .select('id, period_id, paid')
      .eq('company_id', auth.companyId)
      .eq('is_fixed', true)
      .eq('concept', oldConcept)
      .in('period_id', futureIds);
    if (frErr) return apiError('admin/expenses/fixed-forward rows', frErr, { status: 500 });

    const rows = futureRows ?? [];
    if (rows.length > 0) {
      const results = await Promise.all(
        rows.map((r) =>
          admin
            .from('expenses')
            .update({
              concept,
              amount,
              category,
              pending: Math.max(amount - Number(r.paid ?? 0), 0),
              updated_at: now,
            })
            .eq('id', r.id)
            .eq('company_id', auth.companyId),
        ),
      );
      const firstErr = results.find((r) => r.error)?.error;
      if (firstErr) {
        return apiError('admin/expenses/fixed-forward update', firstErr, { status: 500 });
      }
    }

    // Meses distintos afectados (una fila por mes en la práctica, pero
    // contamos períodos para que el mensaje de la UI sea el correcto).
    const updatedPeriods = new Set(rows.map((r) => r.period_id)).size;
    return NextResponse.json({ success: true, updatedPeriods });
  } catch (err) {
    return apiError('admin/expenses/fixed-forward', err, { status: 500 });
  }
}
