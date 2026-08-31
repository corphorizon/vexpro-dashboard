// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/broker-pnl-monthly
//
// La ganancia del BRÓKER mes a mes, derivada del cierre diario del CRM
// (`crm_daily_pnl`, migración 106). Es la fuente automática que reemplaza al
// número tecleado en Carga de Datos — el porqué, las tres reglas y el trato de
// los huecos están en `src/lib/broker-pnl.ts`.
//
// Lee NUESTRO espejo, nunca Orion en vivo (regla G10: una pantalla que consulte
// el Mongo del bróker por visita es una conexión al bróker por visita).
//
// Auth: módulo 'income' —es el número que sustituye a un insumo de ingresos— y
// también 'movements'/'reports', que son las pantallas que lo muestran.
// `company_id` sale SIEMPRE del token: el admin client saltea RLS.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { apiError } from '@/lib/api-error';
import { monthlyBrokerPnl, type BrokerPnlDailyLike } from '@/lib/broker-pnl';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Techo defensivo. El backfill arranca en 2025-10: son ~340 filas hoy y ~365
 * por año. 4.000 son once años; si algún día se toca, el flag `truncated`
 * avisa en vez de devolver una serie recortada que parece completa.
 */
const MAX_ROWS = 4_000;

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAuth(request, { modules: ['income', 'movements', 'reports'] });
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const { data, error } = await admin
      .from('crm_daily_pnl')
      .select('utc_day, pnl_usd, computed_at')
      .eq('company_id', auth.companyId)
      .order('utc_day', { ascending: true })
      .limit(MAX_ROWS);
    if (error) return apiError('admin/broker-pnl-monthly', error, { status: 500 });

    const rows = (data ?? []) as BrokerPnlDailyLike[];

    return NextResponse.json({
      success: true,
      months: monthlyBrokerPnl(rows),
      // Un recorte silencioso es indistinguible de "no hay más".
      truncated: rows.length >= MAX_ROWS,
      signNotice:
        'brokerPnl es la ganancia del BRÓKER: el pnl del cliente de `crm_daily_pnl` con el signo ' +
        'invertido. Un mes sin ningún día utilizable viene con brokerPnl null — SIN DATOS, nunca 0.',
      gapNotice:
        'daysWithData < daysInMonth significa que el mes está INCOMPLETO: el total es el mejor dato ' +
        'que hay, no el mes entero.',
    });
  } catch (err) {
    return apiError('admin/broker-pnl-monthly', err, { status: 500 });
  }
}
