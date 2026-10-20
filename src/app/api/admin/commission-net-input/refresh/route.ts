import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth, HR_ROLES } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { parseMesInsumos, recomputarInsumosComisiones } from '@/lib/hr/insumos-comisiones';

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/commission-net-input/refresh   body: { month: 'YYYY-MM-01' }
//
// El botón «Actualizar» de /comisiones. Recalcula los insumos CRM de ESE mes
// y los deja en la cache (`hr_insumos_comisiones`, migración 132), que es lo
// que lee el GET hermano. Responde `{ success, computed_at, filas, errores }`.
//
// ── Por qué existe ─────────────────────────────────────────────────────────
// Desde la 132 la pantalla lee una cache que llena el cron (mes en curso y
// anterior, diario y cada 4 h). Eso hace la carga instantánea, pero el dato
// tiene una edad, y la pantalla la muestra («CRM calculado hace X min»). Este
// es el camino para quien necesita el número de AHORA — p. ej. justo antes de
// guardar la liquidación — sin esperar al cron.
//
// ── Auth ───────────────────────────────────────────────────────────────────
// La misma llamada que el GET: rol de dominio HR, módulo `commissions`. Como
// es un POST, `verifyAdminAuth` NO relaja el rol por módulo (§4.1: escribir
// lo decide el rol), así que sólo admin/hr — los mismos que pueden guardar
// comisiones. Un socio que sólo LEE la pantalla ve la hora pero no puede
// disparar el recálculo, que cuesta hasta ~30 s de base por mes.
//
// ── Respuesta ──────────────────────────────────────────────────────────────
// · Las dos métricas OK → 200, `errores: []`.
// · Una falló → 200 con `errores` (fijos, sin el error de Postgres): la que
//   llegó se escribió y la otra quedó COMO ESTABA en la cache (merge por
//   columna). La pantalla lo avisa; no es un éxito mudo.
// · Las dos fallaron, o la escritura falló → 502: no se escribió nada y la
//   cache quedó intacta.
//
// DESCARTADO: devolver los insumos en esta misma respuesta. El GET ya sabe
// armarlos (rollup, signo); la pantalla relee el GET, que ahora es un select.
// Dos caminos que arman la misma respuesta es la segunda lista de §1.1.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = 'force-dynamic';
/** Las dos RPC en paralelo, cada una con 30 s de statement_timeout, + la escritura. */
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { roles: HR_ROLES, modules: ['commissions'] });
    if (auth instanceof NextResponse) return auth;

    const body = (await request.json().catch(() => null)) as { month?: unknown } | null;
    const month = parseMesInsumos(body?.month);
    if (!month) {
      return NextResponse.json(
        { success: false, error: 'month inválido (se espera YYYY-MM-01)' },
        { status: 400 },
      );
    }

    // company_id SIEMPRE del token (§4.2), nunca del body.
    const r = await recomputarInsumosComisiones(createAdminClient(), auth.companyId, month);

    if (!r.escrito) {
      return NextResponse.json(
        {
          success: false,
          error: 'No se pudo recalcular el insumo del CRM para ese mes; la cache quedó como estaba',
          errores: r.errores,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      month,
      computed_at: r.computedAt,
      filas: r.filas,
      errores: r.errores,
    });
  } catch (err) {
    return apiError('admin/commission-net-input/refresh', err, { status: 500 });
  }
}
