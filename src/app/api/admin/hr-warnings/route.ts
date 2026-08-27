import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, HR_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import {
  isWarningMotive,
  monthToFirstDay,
  suggestNetDepositWarnings,
  resolveNetDepositGoal,
  type NetDepositGoal,
  type RollupProfile,
} from '@/lib/hr/net-deposit';

// ─────────────────────────────────────────────────────────────────────────────
// /api/admin/hr-warnings — llamados de atención mensuales (RRHH).
//
// GET  ?month=YYYY-MM → lo cargado ese mes, el acumulado histórico por perfil,
//                        las metas vigentes y las SUGERENCIAS de net deposit.
// POST { action:'create' | 'delete' | 'saveGoals' }
//
// LA SUGERENCIA NO SE GUARDA SOLA. El GET calcula quién quedó bajo su meta y lo
// devuelve como sugerencia; recién el POST 'create' —que dispara una persona
// desde la pantalla— escribe la fila. No hay cron ni trigger que inserte
// warnings: esto puede terminar en un despido y lo firma alguien.
//
// El acumulado ("cuando tienen dos o tres", Daniela) es histórico completo, no
// del mes: el mes filtra qué se ve, no qué se cuenta.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE = 1000;

function parseMonth(raw: string | null): string | null {
  if (!raw) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(raw)) return null;
  return monthToFirstDay(raw);
}

type WarningRow = {
  id: string;
  profile_id: string;
  month: string;
  motive: string;
  detail: string | null;
  created_by_name: string | null;
  created_at: string;
};

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: HR_ROLES, modules: ['hr'] });
    if (auth instanceof NextResponse) return auth;

    const month = parseMonth(new URL(request.url).searchParams.get('month'));
    if (!month) {
      return NextResponse.json({ error: 'month inválido (se espera YYYY-MM)' }, { status: 400 });
    }

    const admin = createAdminClient();
    const companyId = auth.companyId;

    // ── Todo el historial de la empresa ───────────────────────────────────
    // Se pagina de verdad: el acumulado por perfil es EL dato que Daniela
    // mira, y PostgREST cortando en 1.000 sin avisar lo dejaría corto justo
    // cuando el módulo empieza a servir para algo (varios años × 126 perfiles).
    const all: WarningRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from('hr_warnings')
        .select('id, profile_id, month, motive, detail, created_by_name, created_at')
        .eq('company_id', companyId)
        .order('month', { ascending: false })
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return apiError('admin/hr-warnings GET', error, { status: 500, withSuccessFlag: false });
      all.push(...((data ?? []) as WarningRow[]));
      if (!data || data.length < PAGE) break;
    }

    const totals: Record<string, number> = {};
    for (const w of all) totals[w.profile_id] = (totals[w.profile_id] ?? 0) + 1;
    const ofMonth = all.filter((w) => w.month.slice(0, 7) === month.slice(0, 7));

    // ── Metas vigentes ────────────────────────────────────────────────────
    const { data: goalRows, error: goalError } = await admin
      .from('hr_net_deposit_goals')
      .select('id, salary, min_net_deposit')
      .eq('company_id', companyId)
      .order('salary', { ascending: true });
    if (goalError) return apiError('admin/hr-warnings goals', goalError, { status: 500, withSuccessFlag: false });
    const goals: NetDepositGoal[] = (goalRows ?? []).map((g) => ({
      salary: Number(g.salary),
      min_net_deposit: Number(g.min_net_deposit),
    }));

    // ── Perfiles + net deposit del mes → sugerencias ──────────────────────
    const profiles: RollupProfile[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from('commercial_profiles')
        .select('id, name, role, head_id, salary, hire_date, status, termination_date')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return apiError('admin/hr-warnings profiles', error, { status: 500, withSuccessFlag: false });
      profiles.push(...((data ?? []) as RollupProfile[]));
      if (!data || data.length < PAGE) break;
    }

    const { data: netRows, error: netError } = await admin.rpc('hr_net_deposit_by_profile', {
      p_company_id: companyId,
      p_month: month,
    });
    if (netError) return apiError('admin/hr-warnings rpc', netError, { status: 500, withSuccessFlag: false });
    const netByProfile = new Map<string, number>();
    for (const r of (netRows ?? []) as { profile_id: string | null; net: number | string }[]) {
      if (r.profile_id) netByProfile.set(r.profile_id, Number(r.net) || 0);
    }

    const alreadyWarned = new Set(
      ofMonth.filter((w) => w.motive === 'net_deposit').map((w) => w.profile_id),
    );
    const suggestions = suggestNetDepositWarnings({
      profiles,
      netByProfile,
      goals,
      month,
      alreadyWarned,
    });

    return NextResponse.json({
      month,
      warnings: ofMonth,
      totals,
      goals: goalRows ?? [],
      suggestions,
      // El net y la meta de cada perfil viajan igual aunque no haya sugerencia:
      // la pantalla muestra "12.000 / 30.000" en la fila de cada quien, y sin
      // esto habría que pedir el rollup por separado para pintar una columna.
      metrics: profiles.map((p) => ({
        profileId: p.id,
        net: netByProfile.get(p.id) ?? 0,
        goal: resolveNetDepositGoal(p.salary, goals),
      })),
    });
  } catch (err) {
    return apiError('admin/hr-warnings GET', err, { status: 500, withSuccessFlag: false });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: HR_ROLES, modules: ['hr'] });
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const admin = createAdminClient();
    const companyId = auth.companyId;

    if (body.action === 'create') {
      const month = parseMonth(body.month ?? null);
      if (!month) return NextResponse.json({ error: 'month inválido (se espera YYYY-MM)' }, { status: 400 });
      if (!body.profile_id) return NextResponse.json({ error: 'profile_id requerido' }, { status: 400 });
      if (!isWarningMotive(body.motive)) {
        return NextResponse.json({ error: 'motivo inválido' }, { status: 400 });
      }

      // El perfil tiene que ser de la empresa del que llama. El admin client
      // bypassea RLS, así que sin esta comprobación un admin de la empresa A
      // podía cargarle un warning a alguien de la empresa B mandando su id.
      const { data: owned } = await admin
        .from('commercial_profiles')
        .select('id')
        .eq('id', body.profile_id)
        .eq('company_id', companyId)
        .maybeSingle();
      if (!owned) {
        return NextResponse.json({ error: 'El perfil no pertenece a tu empresa' }, { status: 403 });
      }

      const { data, error } = await admin
        .from('hr_warnings')
        .insert({
          company_id: companyId,
          profile_id: body.profile_id,
          month,
          motive: body.motive,
          detail: typeof body.detail === 'string' && body.detail.trim() ? body.detail.trim() : null,
          // Se guarda el nombre de quien firma, no su id: dentro de dos años
          // hay que poder leer "lo cargó Daniela" aunque el usuario ya no esté.
          created_by_name: auth.name || auth.email || null,
        })
        .select('id, profile_id, month, motive, detail, created_by_name, created_at')
        .single();

      if (error) {
        // 23505 = choque con el único (empresa, perfil, mes, motivo). No es un
        // error del usuario: confirmar dos veces la misma sugerencia tiene que
        // ser inofensivo, así que se responde OK sin duplicar.
        if ((error as { code?: string }).code === '23505') {
          return NextResponse.json({ success: true, duplicate: true });
        }
        return apiError('admin/hr-warnings create', error, { status: 400, withSuccessFlag: false });
      }
      return NextResponse.json({ success: true, warning: data });
    }

    if (body.action === 'delete') {
      if (!body.id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });
      const { data, error } = await admin
        .from('hr_warnings')
        .delete()
        .eq('id', body.id)
        .eq('company_id', companyId) // nunca borrar filas de otra empresa
        .select('id');
      if (error) return apiError('admin/hr-warnings delete', error, { status: 400, withSuccessFlag: false });
      if (!data || data.length === 0) {
        return NextResponse.json({ error: 'No se encontró el warning en esta empresa' }, { status: 404 });
      }
      return NextResponse.json({ success: true });
    }

    if (body.action === 'saveGoals') {
      // Las metas son una regla de negocio, no una constante del código: acá se
      // reemplaza la tabla completa de escalones de la empresa. Se valida la
      // forma antes de tocar nada — media tabla guardada sería peor que ninguna.
      const raw = Array.isArray(body.goals) ? body.goals : null;
      if (!raw || raw.length === 0) {
        return NextResponse.json({ error: 'Hace falta al menos un escalón' }, { status: 400 });
      }
      const parsed: { salary: number; min_net_deposit: number }[] = [];
      for (const g of raw) {
        const salary = Number(g?.salary);
        const min = Number(g?.min_net_deposit);
        if (!Number.isFinite(salary) || salary < 0 || !Number.isFinite(min) || min < 0) {
          return NextResponse.json({ error: 'Escalón inválido' }, { status: 400 });
        }
        if (parsed.some((p) => p.salary === salary)) {
          return NextResponse.json({ error: 'Hay dos escalones con el mismo salario' }, { status: 400 });
        }
        parsed.push({ salary, min_net_deposit: min });
      }

      const { error: delError } = await admin
        .from('hr_net_deposit_goals')
        .delete()
        .eq('company_id', companyId);
      if (delError) return apiError('admin/hr-warnings goals delete', delError, { status: 400, withSuccessFlag: false });

      const { error: insError } = await admin
        .from('hr_net_deposit_goals')
        .insert(parsed.map((g) => ({ company_id: companyId, ...g })));
      if (insError) return apiError('admin/hr-warnings goals insert', insError, { status: 400, withSuccessFlag: false });

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  } catch (err) {
    return apiError('admin/hr-warnings POST', err, { status: 500, withSuccessFlag: false });
  }
}
