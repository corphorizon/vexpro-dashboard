// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/hedge-fund/maturities
//
// El calendario: cuánto CAPITAL vence cada mes y cuánto rendimiento habría que
// pagar sobre él si el fondo rinde lo que promete.
//
// ── LA MITAD DE ESTA RESPUESTA NO ES UN DATO ───────────────────────────────
// El capital SÍ lo es: sale de `principal` con su `endDate`. La proyección NO:
// es `principal × retornoEsperado × permanencia/12`, y `retornoEsperado` es un
// TEXTO escrito a mano en el CRM ('22-26%'). Por eso viaja como `projected` y
// no mezclado con el capital, viene con `withoutProjection` (cuántas
// inversiones del mes no se pudieron proyectar) y la pantalla la rotula
// «proyección al retorno esperado, no es dato».
//
// Un mes donde NINGUNA inversión se pudo proyectar devuelve `projected: null`,
// no ceros: un 0 se leería como «ese mes no rinde nada».
//
// Sólo entran las inversiones ACTIVE. Una TERMINATED ya devolvió su capital, y
// sumarla diría que hay que devolverlo otra vez.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { bucketMaturities, buildMaturityCalendar, isActive } from '@/lib/hedge-fund/aggregate';
import { mirrorIsStale, readHedgeFundMirror } from '@/lib/hedge-fund/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAuth(request, { modules: ['hedge_fund'] });
  if (auth instanceof NextResponse) return auth;

  try {
    const admin = createAdminClient();
    const mirror = await readHedgeFundMirror(admin, auth.companyId, {
      funds: true, investments: true, monthlyReturns: true,
    });

    const activas = mirror.investments.filter(isActive);

    return NextResponse.json({
      success: true,
      months: buildMaturityCalendar(mirror.investments, mirror.funds),
      buckets: bucketMaturities(mirror.investments),
      /**
       * Activas SIN fecha de vencimiento: no entran a ningún mes y por eso hay
       * que decirlo. Un capital que desaparece del calendario sin aviso es un
       * capital que nadie prevé devolver.
       */
      activeWithoutEndDate: activas.filter((i) => !i.end_date).length,
      activeCount: activas.length,
      /**
       * `hedgefundmonthlyreturns` está VACÍA en las dos empresas al 2026-09-02.
       * Se devuelve igual: cuando el CRM la llene, la pantalla podrá contrastar
       * la proyección contra el rendimiento REAL del mes. Lista vacía = «sin
       * datos», y así se dibuja.
       */
      actualMonthlyReturns: mirror.monthlyReturns.map((m) => ({
        fundKey: m.fund_key,
        ym: m.ym,
        percent: m.percent,
        amount: m.amount,
      })),
      excluded: mirror.excluded,
      lastSyncedAt: mirror.lastSyncedAt,
      stale: mirrorIsStale(mirror.lastSyncedAt),
    });
  } catch (err) {
    return apiError('admin/hedge-fund/maturities', err, { status: 500 });
  }
}
