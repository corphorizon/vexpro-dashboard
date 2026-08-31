import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, HR_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { monthToFirstDay, type NetDepositGoal } from '@/lib/hr/net-deposit';
import { leerNetDelCrm, leerPerfilesComerciales } from '@/lib/hr/crm-net-server';
import {
  armarOverview,
  HR_OVERVIEW_CRITICAL,
  type HrMonthlyResultRow,
  type HrPeriodRow,
  type HrWarningRow,
} from '@/lib/hr/overview';

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/hr-overview?month=YYYY-MM — TODO lo del mes, en una llamada.
//
// ── El porqué, con la medición ─────────────────────────────────────────────
// /rrhh tenía nueve pestañas y cada una se cargaba sola: `commercial-profiles`,
// `hr-net-deposit-rollup`, `hr-warnings`, `hr-ib-production-rollup`,
// `ib-negotiations`, `ib-rebates` y `negotiations`, más lo que ya trae el
// bootstrap. Tres de esos endpoints repiten EXACTAMENTE el mismo trabajo caro:
// paginar `commercial_profiles` (126 filas) y llamar a la RPC
// `hr_net_deposit_by_profile`. Cambiar de pestaña lo volvía a pagar entero.
//
// Esta ruta lo hace UNA vez por mes y el cliente lo cachea (ver
// rrhh/_components/hr-period-context.tsx). Los endpoints viejos SIGUEN VIVOS:
// tienen otros consumidores y escrituras (POST de warnings, CRUD de
// ib-negotiations). Éste es de LECTURA AGREGADA y nada más — no escribe en
// ninguna tabla.
//
// ── Mismo contrato que /api/bootstrap ──────────────────────────────────────
// · `verifyAdminAuth(HR_ROLES, ['hr'])` — leer lo decide el módulo (§4.1).
// · `company_id` del token, y `.eq('company_id', …)` en CADA consulta: el admin
//   client es service role y NO pasa por RLS (§4.2).
// · Un slice que falla vuelve `null` y su nombre aparece en `partial`. Nunca
//   `[]` mudo: una lista vacía silenciosa es indistinguible de un cruce roto.
// · `profiles` es crítico (HR_OVERVIEW_CRITICAL): si falla, 502.
//
// El armado vive en src/lib/hr/overview.ts, que es puro y está testeado.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';
/** La RPC del rollup tarda ~2 s con 21.182 clientes (migración 115: índices). */
export const maxDuration = 60;

const PAGE = 1000;

/** `2026-07` o `2026-07-01`; cualquier otra cosa se rechaza. */
function parseMonth(raw: string | null): string | null {
  if (!raw) return null;
  if (!/^\d{4}-(0[1-9]|1[0-2])(-\d{2})?$/.test(raw)) return null;
  return monthToFirstDay(raw);
}

/**
 * Lee una tabla entera paginando de verdad.
 *
 * PostgREST corta en 1.000 filas SIN AVISAR. Hoy hay 126 perfiles, pero el día
 * que una empresa pase el límite el bug sería "al head le faltan BDM" y nadie
 * lo relacionaría con esta línea. Devuelve `null` si falló: el llamador lo
 * traduce a un slice `partial`, jamás a `[]`.
 */
async function leerTodo<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
  slice: string,
): Promise<T[] | null> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let res: { data: unknown[] | null; error: unknown };
    try {
      res = await build(from, from + PAGE - 1);
    } catch (err) {
      console.error(`[hr-overview] slice "${slice}" lanzó:`, err);
      return null;
    }
    if (res.error) {
      console.error(`[hr-overview] slice "${slice}" falló:`, res.error);
      return null;
    }
    const data = res.data ?? [];
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return out;
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

    // El período contable se lee PRIMERO porque `monthlyResults` cuelga de él.
    // Puede no existir (los períodos se crean a mano): en ese caso no hay
    // "manual" y el calculado se muestra solo — no es un error.
    const { data: periodRow, error: periodError } = await admin
      .from('periods')
      .select('id, year, month, is_closed')
      .eq('company_id', companyId)
      .eq('year', Number(month.slice(0, 4)))
      .eq('month', Number(month.slice(5, 7)))
      .maybeSingle();
    if (periodError) {
      // El período NO es un slice opcional: sin saber si existe no se puede
      // distinguir "no hay nada cargado" de "no pudimos mirar".
      return apiError('admin/hr-overview period', periodError, { status: 502, withSuccessFlag: false });
    }
    const period = (periodRow ?? null) as HrPeriodRow | null;

    const [profiles, netRows, monthlyResults, goalRows, allWarnings] = await Promise.all([
      // Las dos primeras salen del registro único src/lib/hr/crm-net-server.ts:
      // el paginado de perfiles y la RPC del rollup estaban copiados acá, en
      // /api/admin/hr-net-deposit-rollup y —desde la tanda 2— los pedía también
      // /api/admin/commission-net-input. Tres copias de la misma llamada es cómo
      // se termina con dos pantallas mostrando dos netos distintos.
      leerPerfilesComerciales(admin, companyId),
      leerNetDelCrm(admin, companyId, month),
      period
        ? leerTodo<HrMonthlyResultRow>(
            (from, to) =>
              admin
                .from('commercial_monthly_results')
                // `head_id` viaja desde la tanda 2: sin él no se puede saber si
                // una fila es el total de la estructura o la línea propia del
                // head en su propio grupo (ver `manualDeEstructura`).
                .select('profile_id, net_deposit_current, head_id')
                .eq('company_id', companyId)
                .eq('period_id', period.id)
                .order('id', { ascending: true })
                .range(from, to),
            'monthlyResults',
          )
        : // Sin período no hay filas que leer. `[]` acá es la respuesta correcta
          // (y `hasPeriod:false` lo explica), no un fallo disfrazado.
          Promise.resolve([] as HrMonthlyResultRow[]),
      admin
        .from('hr_net_deposit_goals')
        .select('id, salary, min_net_deposit')
        .eq('company_id', companyId)
        .order('salary', { ascending: true })
        .then(
          ({ data, error }) => {
            if (error) {
              console.error('[hr-overview] slice "goals" falló:', error);
              return null;
            }
            return (data ?? []) as { id: string; salary: number; min_net_deposit: number }[];
          },
          (err) => {
            console.error('[hr-overview] slice "goals" lanzó:', err);
            return null;
          },
        ),
      // El acumulado de warnings es HISTÓRICO completo (Daniela: «cuando tienen
      // dos o tres»): el mes filtra qué se ve, no qué se cuenta.
      leerTodo<HrWarningRow>(
        (from, to) =>
          admin
            .from('hr_warnings')
            .select('id, profile_id, month, motive, detail, created_by_name, created_at')
            .eq('company_id', companyId)
            .order('month', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to),
        'warnings',
      ),
    ]);

    const goals: NetDepositGoal[] | null =
      goalRows === null
        ? null
        : goalRows.map((g) => ({ salary: Number(g.salary), min_net_deposit: Number(g.min_net_deposit) }));

    const overview = armarOverview({
      month,
      period,
      profiles,
      netRows,
      monthlyResults,
      goals,
      goalRows,
      allWarnings,
    });

    const criticoRoto = overview.partial.filter((s) =>
      (HR_OVERVIEW_CRITICAL as readonly string[]).includes(s),
    );
    if (criticoRoto.length > 0) {
      return NextResponse.json(
        { error: 'No se pudo cargar la estructura comercial', partial: criticoRoto },
        { status: 502 },
      );
    }

    // `goalRows` (los escalones con su `id`) van dentro del overview: los
    // necesita el editor de metas de la pestaña Warnings, que hasta ahora los
    // recibía del GET de /api/admin/hr-warnings.
    return NextResponse.json(overview);
  } catch (err) {
    return apiError('admin/hr-overview', err, { status: 500, withSuccessFlag: false });
  }
}
