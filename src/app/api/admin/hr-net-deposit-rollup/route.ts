import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, HR_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { buildRollup, monthToFirstDay, type RollupProfile } from '@/lib/hr/net-deposit';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/hr-net-deposit-rollup?month=YYYY-MM
//
// El net deposit del mes por BDM y su acumulado por HEAD, sacado del CRM. Es lo
// que hoy Daniela arma a mano: «ingreso al equipo de Hugo y miro en el CRM
// cuánto tiene en total y de ese total miro cada uno».
//
// DEVUELVE SUGERENCIAS, NO PISA NADA. Junto a cada calculado viaja el `manual`
// que hay cargado en commercial_monthly_results para ese mes, para que se lean
// uno al lado del otro. Esta ruta no escribe en ninguna tabla: es GET y nada más.
//
// El trabajo pesado (subir la cadena de sponsors de 21.182 clientes) lo hace el
// RPC `hr_net_deposit_by_profile` (migración 097), no este handler. Acá solo se
// arma el árbol por head_id, que son ~126 filas.
//
// Lectura la decide el módulo (`hr`), escritura el rol — mismo gate que las
// rutas vecinas de RRHH.
// ─────────────────────────────────────────────────────────────────────────────

/** `2026-07` o `2026-07-01`; cualquier otra cosa se rechaza. */
function parseMonth(raw: string | null): string | null {
  if (!raw) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(raw)) return null;
  return monthToFirstDay(raw);
}

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

    // ── Perfiles ──────────────────────────────────────────────────────────
    // Se traen TODOS, incluidos los despedidos: un BDM que se fue el 20 del mes
    // igual produjo hasta ese día y su plata tiene que aparecer bajo su head, o
    // el total del equipo no cierra contra el CRM.
    // `.range()` + `.order()`: PostgREST corta en 1.000 filas sin avisar y hoy
    // hay 126 perfiles, pero el día que una empresa pase el límite el bug sería
    // "al head le faltan BDM" y nadie lo relacionaría con esta línea.
    const profiles: RollupProfile[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from('commercial_profiles')
        .select('id, name, role, head_id, salary, hire_date, status, termination_date')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return apiError('admin/hr-net-deposit-rollup profiles', error, { status: 500, withSuccessFlag: false });
      profiles.push(...((data ?? []) as RollupProfile[]));
      if (!data || data.length < PAGE) break;
    }

    // ── Lo calculado desde el CRM ─────────────────────────────────────────
    const { data: netRows, error: netError } = await admin.rpc('hr_net_deposit_by_profile', {
      p_company_id: companyId,
      p_month: month,
    });
    if (netError) return apiError('admin/hr-net-deposit-rollup rpc', netError, { status: 500, withSuccessFlag: false });

    const netByProfile = new Map<string, number>();
    // profile_id NULL = clientes cuya cadena de sponsors no llega a ningún
    // comercial de la estructura. Medido en julio 2026: 18.314 de 556.917, el
    // 3,3%. Se devuelve aparte y la pantalla lo muestra como "sin asignar" —
    // repartirlo a ojo entre los heads sería inventar producción.
    let unassigned = 0;
    for (const r of (netRows ?? []) as { profile_id: string | null; net: number | string }[]) {
      const v = Number(r.net) || 0;
      if (r.profile_id) netByProfile.set(r.profile_id, v);
      else unassigned += v;
    }

    // ── Lo que hay cargado a mano, para leerlo al lado ────────────────────
    // Puede no haber período contable para ese mes (los períodos se crean a
    // mano): en ese caso no hay manual y listo, el calculado se muestra solo.
    const manualByProfile = new Map<string, number>();
    const [year, mon] = month.split('-');
    const { data: period } = await admin
      .from('periods')
      .select('id')
      .eq('company_id', companyId)
      .eq('year', Number(year))
      .eq('month', Number(mon))
      .maybeSingle();

    if (period) {
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await admin
          .from('commercial_monthly_results')
          .select('profile_id, net_deposit_current')
          .eq('company_id', companyId)
          .eq('period_id', period.id)
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) return apiError('admin/hr-net-deposit-rollup manual', error, { status: 500, withSuccessFlag: false });
        for (const r of data ?? []) {
          // Un perfil puede tener más de una fila en el mes (una por head bajo
          // el que aparece). Lo cargado para esa persona es la suma.
          const prev = manualByProfile.get(r.profile_id) ?? 0;
          manualByProfile.set(r.profile_id, prev + (Number(r.net_deposit_current) || 0));
        }
        if (!data || data.length < PAGE) break;
      }
    }

    const tree = buildRollup(profiles, netByProfile, period ? manualByProfile : undefined);
    const totalAssigned = [...netByProfile.values()].reduce((s, v) => s + v, 0);

    return NextResponse.json({
      month,
      hasPeriod: !!period,
      tree,
      unassigned,
      totalAssigned,
      // El total del CRM del mes = lo atribuido + lo huérfano. Es el número
      // contra el que Daniela cuadra hoy mirando la pantalla del CRM.
      totalCrm: totalAssigned + unassigned,
    });
  } catch (err) {
    return apiError('admin/hr-net-deposit-rollup', err, { status: 500, withSuccessFlag: false });
  }
}
