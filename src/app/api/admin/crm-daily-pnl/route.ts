// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/crm-daily-pnl?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// El cierre diario de PNL tal como lo da el CRM, ya guardado en
// `crm_daily_pnl` (migración 106). Lee NUESTRO espejo, nunca Orion en vivo:
// una pantalla que consulte el Mongo del bróker por visita es una conexión al
// bróker por visita, y además el dato de un día que pasó ya no está completo
// en el origen (Orion purga documentos hacia atrás).
//
// Auth: módulo 'risk' y los mismos roles que la exposición y la cola de
// retiros. Es información de riesgo del negocio y la mira la misma gente.
//
// El `company_id` sale SIEMPRE del token — nunca del query string.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { WITHDRAWAL_REVIEW_READ_ROLES } from '@/lib/roles';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadCrmDailyPnl } from '@/lib/crm-sync/daily-pnl-query';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Días del rango por defecto: un mes, el horizonte con el que se mira una racha. */
const DIAS_POR_DEFECTO = 30;

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, {
      roles: WITHDRAWAL_REVIEW_READ_ROLES,
      modules: ['risk'],
    });
    if (auth instanceof NextResponse) return auth;

    const DIA = 86_400_000;
    const hoy = new Date().toISOString().slice(0, 10);
    const pedido = (k: string) => {
      const v = request.nextUrl.searchParams.get(k);
      return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
    };
    const to = pedido('to') ?? hoy;
    const from =
      pedido('from') ??
      new Date(Date.parse(`${to}T00:00:00.000Z`) - (DIAS_POR_DEFECTO - 1) * DIA)
        .toISOString()
        .slice(0, 10);
    if (from > to) {
      return NextResponse.json(
        { success: false, error: 'El rango de fechas empieza después de terminar.' },
        { status: 400 },
      );
    }

    const serie = await loadCrmDailyPnl(createAdminClient(), auth.companyId, from, to);

    return NextResponse.json({
      success: true,
      ...serie,
      today: hoy,
      // Contrato explícito, igual que en /api/admin/risk-exposure: el signo de
      // este número cambia de significado según quién lo mire.
      signNotice:
        'pnl_usd es el PNL del CLIENTE, con el mismo signo que el panel de Orion: negativo = el ' +
        'cliente perdió = el bróker ganó. `totals.brokerPnl` es el mismo número invertido.',
      gapNotice:
        'Un día sin fila es SIN DATO, nunca cero. Los días que faltan en el rango vienen en ' +
        '`daysMissing`; el cron los recupera solo en su próxima ventana.',
    });
  } catch (err) {
    return apiError('admin/crm-daily-pnl', err, { status: 500 });
  }
}
