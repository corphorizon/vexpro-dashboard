import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';

// POST   — create profile   { action: 'create', ...fields }
// PATCH  — update profile   { action: 'update', id, ...fields }
// DELETE — delete profile   { action: 'delete', id }

// Fields a client is allowed to set on commercial_profiles.
// Must match actual DB columns — no 'phone' (doesn't exist in table).
const ALLOWED_FIELDS = [
  'name', 'role', 'head_id', 'net_deposit_pct', 'extra_pct', 'pnl_pct',
  'commission_per_lot', 'salary', 'fixed_salary',
  'pnl_special_mode',
  // BDM GLOBAL — campos extra del HEAD/Sales Manager
  'pct_sobre_bdm_global', 'pct_extra_sobre_head', 'apply_pct_extra_to_head_without_salary',
  'benefits', 'comments',
  'status', 'email', 'hire_date', 'birthday', 'contract_url',
  'termination_date',
  'termination_reason',
  'termination_category',
  'terminated_by',
] as const;

function pickAllowed(obj: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_FIELDS) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { action, id } = body;
    const admin = createAdminClient();

    // Always use the caller's verified company — never trust body.company_id
    const company_id = auth.companyId;

    if (action === 'create') {
      const safe = pickAllowed(body);
      const { data, error } = await admin
        .from('commercial_profiles')
        .insert({ company_id, ...safe, status: (safe.status as string) || 'active' })
        .select('id')
        .single();
      if (error) return apiError('admin/commercial-profiles', error, { status: 400, withSuccessFlag: false });
      return NextResponse.json({ success: true, id: data.id });
    }

    if (action === 'update') {
      if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
      const safe = pickAllowed(body);

      // Detectar cambio de HEAD para reconciliar el registro del período ACTUAL
      // y no dejar registros huérfanos bajo el head viejo. Solo el período
      // actual (el último) se mueve/limpia; los meses pasados quedan como
      // estaban (historia intacta) — es la política elegida ("solo del mes
      // actual en adelante"). Leemos el head viejo ANTES de actualizar.
      let headReassign: { oldHead: string; newHead: string | null } | null = null;
      if ('head_id' in safe) {
        const { data: existing } = await admin
          .from('commercial_profiles')
          .select('head_id')
          .eq('id', id)
          .eq('company_id', company_id)
          .maybeSingle();
        const oldHead = existing?.head_id ?? null;
        const newHead = (safe.head_id as string | null) ?? null;
        if (oldHead && oldHead !== newHead) headReassign = { oldHead, newHead };
      }

      const { data, error } = await admin
        .from('commercial_profiles')
        .update(safe)
        .eq('id', id)
        .eq('company_id', company_id) // scope to caller's company
        .select('id');
      if (error) return apiError('admin/commercial-profiles', error, { status: 400, withSuccessFlag: false });
      // Defensive: if neither id nor (id + company_id) matched, surface a 404
      // rather than a misleading { success: true }. Silent 0-row updates make
      // UI bugs invisible.
      if (!data || data.length === 0) {
        return NextResponse.json(
          { error: 'No se encontró el perfil en esta empresa (id/company_id no matchean)' },
          { status: 404 },
        );
      }

      // Reconciliar el período actual tras el cambio de head. Best-effort: si
      // algo falla, el perfil ya se actualizó — no reventamos la respuesta.
      if (headReassign) {
        try {
          const { oldHead, newHead } = headReassign;
          // Período actual = el más reciente de la empresa (año/mes desc).
          const { data: latest } = await admin
            .from('periods')
            .select('id')
            .eq('company_id', company_id)
            .order('year', { ascending: false })
            .order('month', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (latest) {
            // Registro del período actual bajo el head VIEJO (posible huérfano).
            const { data: oldRows } = await admin
              .from('commercial_monthly_results')
              .select('id')
              .eq('profile_id', id)
              .eq('company_id', company_id)
              .eq('period_id', latest.id)
              .eq('head_id', oldHead);
            if (oldRows && oldRows.length > 0) {
              // ¿El head NUEVO ya tiene registro en el período actual?
              let newExists = false;
              if (newHead) {
                const { data: newRows } = await admin
                  .from('commercial_monthly_results')
                  .select('id')
                  .eq('profile_id', id)
                  .eq('company_id', company_id)
                  .eq('period_id', latest.id)
                  .eq('head_id', newHead)
                  .limit(1);
                newExists = !!(newRows && newRows.length > 0);
              }
              const oldIds = oldRows.map((r) => r.id);
              if (newExists) {
                // Ya existe bajo el nuevo head → borrar el huérfano del viejo.
                await admin.from('commercial_monthly_results').delete().in('id', oldIds);
              } else {
                // Mover el registro del período actual al nuevo head (preserva datos).
                await admin
                  .from('commercial_monthly_results')
                  .update({ head_id: newHead })
                  .in('id', oldIds);
              }
            }
          }
        } catch (reconErr) {
          console.warn('[admin/commercial-profiles] reconciliacion de head fallo (no fatal):', reconErr);
        }
      }

      return NextResponse.json({ success: true });
    }

    if (action === 'delete') {
      if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
      await admin.from('commercial_monthly_results').delete()
        .eq('profile_id', id)
        .eq('company_id', company_id);
      const { error } = await admin.from('commercial_profiles').delete()
        .eq('id', id)
        .eq('company_id', company_id); // scope to caller's company
      if (error) return apiError('admin/commercial-profiles', error, { status: 400, withSuccessFlag: false });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return apiError('admin/commercial-profiles', err, { status: 500, withSuccessFlag: false });
  }
}
