import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, HR_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { monthToFirstDay, type RollupProfile } from '@/lib/hr/net-deposit';
import { buildIbProductionRollup, type IbProduction } from '@/lib/hr/ib-production';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/hr-ib-production-rollup?month=YYYY-MM
//
// La producción IB del mes por BDM y su acumulado por HEAD: lotes pagados,
// comisión, PNL atribuido, cantidad de pagos por lotes y el desglose entre
// activos de forex/CFD y activos sintéticos.
//
// Lo pidió Kevin el 2026-08-27 y va al lado del net deposit a propósito: es la
// misma estructura mirada con otra métrica, y Daniela no tiene que abrir dos
// pantallas para ver la producción de un equipo.
//
// TODO ES USD. Verificado en el origen: `currency: 'USD'` en el 100% de las
// filas de `ib_reward_daily` y de `ibrewards`. Los lotes son ESTÁNDAR — las
// cuentas cent ya vienen convertidas ÷100 por el bróker.
//
// ── SIN DATO ≠ CERO, Y ACÁ SE DECIDE ──────────────────────────────────────
// El desglose forex/sintéticos sale de `ibrewards`, que el bróker PURGA a los
// quince días. Los meses anteriores a que el espejo empezara a correr no lo
// tienen y nunca lo van a tener. Esta ruta devuelve, además del árbol, de qué
// días de ese mes hay desglose (`symbolCoverage`); la pantalla usa eso para
// decir "sin dato" en vez de dibujar un cero que nadie podría distinguir de
// "ese equipo no operó sintéticos".
//
// El trabajo pesado (subir la cadena de sponsors de 21.182 clientes y agregar
// el mes) lo hace el RPC `hr_ib_production_by_profile` (migración 098). Acá
// sólo se arma el árbol, que son ~126 filas.
//
// Esta ruta NO ESCRIBE NADA: es GET. El espejo lo llena el cron sync-crm.
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

/** Cuántos días tiene el mes que arranca en `firstDay`. */
function daysInMonth(firstDay: string): number {
  const [y, m] = firstDay.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

type RpcRow = {
  profile_id: string | null;
  lots: number | string;
  commission: number | string;
  pnl: number | string;
  rewards_count: number | string;
  ibs: number | string;
  forex_lots: number | string | null;
  forex_commission: number | string | null;
  synthetic_lots: number | string | null;
  synthetic_commission: number | string | null;
};

/** numeric de Postgres llega como string por JSON. null se preserva. */
function n(v: number | string | null | undefined): number {
  return Number(v) || 0;
}
function nOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
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
    // igual produjo hasta ese día y su producción tiene que aparecer bajo su
    // head. `.range()` + `.order()` porque PostgREST corta en 1.000 sin avisar
    // y el día que una empresa pase el límite el bug sería "al head le faltan
    // BDM", que nadie relacionaría con esta línea.
    const profiles: RollupProfile[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await admin
        .from('commercial_profiles')
        .select('id, name, role, head_id, salary, hire_date, status, termination_date')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) return apiError('admin/hr-ib-production-rollup profiles', error, { status: 500, withSuccessFlag: false });
      profiles.push(...((data ?? []) as RollupProfile[]));
      if (!data || data.length < PAGE) break;
    }

    // ── Lo calculado desde el espejo del CRM ──────────────────────────────
    const { data: rows, error: rpcError } = await admin.rpc('hr_ib_production_by_profile', {
      p_company_id: companyId,
      p_month: month,
    });
    if (rpcError) return apiError('admin/hr-ib-production-rollup rpc', rpcError, { status: 500, withSuccessFlag: false });

    const byProfile = new Map<string, IbProduction>();
    // profile_id NULL = IB cuya cadena de sponsors no llega a ningún comercial
    // de la estructura. Se devuelve aparte como "sin asignar": repartirlo entre
    // los heads sería inventar producción.
    let unassigned: IbProduction | null = null;

    for (const r of (rows ?? []) as RpcRow[]) {
      const p: IbProduction = {
        lots: n(r.lots),
        commission: n(r.commission),
        pnl: n(r.pnl),
        rewards: n(r.rewards_count),
        ibs: n(r.ibs),
        forexLots: nOrNull(r.forex_lots),
        forexCommission: nOrNull(r.forex_commission),
        syntheticLots: nOrNull(r.synthetic_lots),
        syntheticCommission: nOrNull(r.synthetic_commission),
      };
      if (r.profile_id) byProfile.set(r.profile_id, p);
      else unassigned = p;
    }

    // ── De qué días del mes hay desglose ──────────────────────────────────
    // Se pregunta al espejo, no se deduce del árbol: un mes puede tener cero
    // filas de desglose porque no está cubierto (sin dato) o porque nadie operó
    // (cero), y sólo esta consulta distingue las dos cosas.
    const finMes = `${month.slice(0, 8)}${String(daysInMonth(month)).padStart(2, '0')}`;
    const { data: dias, error: diasError } = await admin
      .from('crm_ib_reward_symbol_daily')
      .select('day')
      .eq('company_id', companyId)
      .gte('day', month)
      .lte('day', finMes)
      .order('day', { ascending: true })
      .range(0, 999);
    if (diasError) return apiError('admin/hr-ib-production-rollup dias', diasError, { status: 500, withSuccessFlag: false });
    const diasCubiertos = [...new Set((dias ?? []).map((d) => String(d.day).slice(0, 10)))].sort();

    const tree = buildIbProductionRollup(profiles, byProfile);

    let totals: IbProduction | null = null;
    for (const [, p] of byProfile) {
      totals = totals === null ? { ...p } : {
        lots: totals.lots + p.lots,
        commission: totals.commission + p.commission,
        pnl: totals.pnl + p.pnl,
        rewards: totals.rewards + p.rewards,
        ibs: totals.ibs + p.ibs,
        forexLots: p.forexLots === null ? totals.forexLots : (totals.forexLots ?? 0) + p.forexLots,
        forexCommission: p.forexCommission === null ? totals.forexCommission : (totals.forexCommission ?? 0) + p.forexCommission,
        syntheticLots: p.syntheticLots === null ? totals.syntheticLots : (totals.syntheticLots ?? 0) + p.syntheticLots,
        syntheticCommission: p.syntheticCommission === null ? totals.syntheticCommission : (totals.syntheticCommission ?? 0) + p.syntheticCommission,
      };
    }

    return NextResponse.json({
      month,
      currency: 'USD',
      tree,
      unassigned,
      totalAssigned: totals,
      symbolCoverage: {
        // Días de ESE mes que tienen desglose espejado, y cuántos tiene el mes.
        // days = 0 → la pantalla dice "sin dato", nunca cero.
        days: diasCubiertos.length,
        daysInMonth: daysInMonth(month),
        from: diasCubiertos[0] ?? null,
        to: diasCubiertos[diasCubiertos.length - 1] ?? null,
      },
    });
  } catch (err) {
    return apiError('admin/hr-ib-production-rollup', err, { status: 500, withSuccessFlag: false });
  }
}
