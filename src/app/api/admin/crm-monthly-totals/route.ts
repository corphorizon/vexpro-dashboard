// ---------------------------------------------------------------------------
// GET /api/admin/crm-monthly-totals
//
// La serie mensual que el cron calcula desde el CRM (`crm_monthly_totals`,
// migración 100) puesta AL LADO de lo que hay cargado a mano para el mismo
// mes, con la diferencia. Nada se suma: son el mismo dinero contado por dos
// caminos, y sumarlos lo duplicaría — medido: `prop_firm_sales` de Vex Pro ya
// tiene, mes por mes, exactamente el `amountPaid` de Orion.
//
// Sólo lectura. La escritura de la serie automática es del cron (service
// role); la de lo manual sigue siendo la de siempre (/api/admin/data).
//
// company_id sale SIEMPRE del JWT: el admin client saltea RLS.
// ---------------------------------------------------------------------------

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { CRM_MONTHLY_METRIC_KEYS } from '@/lib/crm-monthly';

/** Techo defensivo: 6 métricas × 12 meses × 10 años no llega a esto. */
const MAX_ROWS = 5_000;

export interface CrmMonthlyRow {
  year: number;
  month: number;
  metric: string;
  /** null = el mes no se pudo calcular. Nunca 0 por defecto. */
  auto: number | null;
  currency: string;
  txCount: number;
  excludedCount: number;
  excludedAmount: number;
  detail: Record<string, unknown> | null;
  computedAt: string | null;
  /** Lo cargado a mano para ese mes. null = no hay período o no se cargó. */
  manual: number | null;
  periodLabel: string | null;
  periodClosed: boolean | null;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAuth(request, { modules: ['income', 'movements', 'reports'] });
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const companyId = auth.companyId;

    const [autoRes, periodsRes] = await Promise.all([
      admin
        .from('crm_monthly_totals')
        .select('year, month, metric, amount, currency, tx_count, excluded_count, excluded_amount, detail, computed_at')
        .eq('company_id', companyId)
        .order('year', { ascending: false })
        .order('month', { ascending: false })
        .limit(MAX_ROWS),
      admin
        .from('periods')
        .select('id, year, month, label, is_closed')
        .eq('company_id', companyId)
        .limit(600),
    ]);
    if (autoRes.error) return apiError('admin/crm-monthly-totals auto', autoRes.error, { status: 500 });
    if (periodsRes.error) return apiError('admin/crm-monthly-totals periods', periodsRes.error, { status: 500 });

    const periods = periodsRes.data ?? [];
    const periodIds = periods.map((p) => p.id as string);

    // Lo manual de cada métrica. Se pide sólo si hay períodos: un `.in()` con
    // lista vacía devuelve todo en algunas versiones de PostgREST.
    let p2p: Array<{ period_id: string; amount: number }> = [];
    let ventas: Array<{ period_id: string; amount: number }> = [];
    let retiros: Array<{ period_id: string; amount: number }> = [];
    if (periodIds.length > 0) {
      const [a, b, c] = await Promise.all([
        admin.from('p2p_transfers').select('period_id, amount').eq('company_id', companyId).in('period_id', periodIds),
        admin.from('prop_firm_sales').select('period_id, amount').eq('company_id', companyId).in('period_id', periodIds),
        admin.from('withdrawals').select('period_id, amount').eq('company_id', companyId).eq('category', 'prop_firm').in('period_id', periodIds),
      ]);
      if (a.error) return apiError('admin/crm-monthly-totals p2p', a.error, { status: 500 });
      if (b.error) return apiError('admin/crm-monthly-totals ventas', b.error, { status: 500 });
      if (c.error) return apiError('admin/crm-monthly-totals retiros', c.error, { status: 500 });
      p2p = (a.data ?? []) as typeof p2p;
      ventas = (b.data ?? []) as typeof ventas;
      retiros = (c.data ?? []) as typeof retiros;
    }

    const sumByPeriod = (rows: Array<{ period_id: string; amount: number }>) => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(r.period_id, (m.get(r.period_id) ?? 0) + (Number(r.amount) || 0));
      return m;
    };
    // Sólo las tres métricas comparables tienen contraparte manual. Las
    // INFORMATIVAS (comisiones IB, social trading fees, fee debt recovery) no
    // se cargan a mano en ningún lado y no cuentan en el resultado: su
    // `manual` sale null, que es lo correcto — inventarles un 0 invitaría a
    // restarlas contra una cifra de finanzas.
    const manualByMetric: Record<string, Map<string, number>> = {
      p2p_transfers: sumByPeriod(p2p),
      propfirm_sales: sumByPeriod(ventas),
      propfirm_withdrawals: sumByPeriod(retiros),
    };

    const periodByMonth = new Map(periods.map((p) => [`${p.year}-${p.month}`, p]));

    const rows: CrmMonthlyRow[] = (autoRes.data ?? []).map((r) => {
      const key = `${r.year}-${r.month}`;
      const period = periodByMonth.get(key);
      const manualMap = manualByMetric[r.metric as string];
      // `null` cuando no hay período o la fila manual no existe: "no cargado"
      // no es "cero". Es la diferencia entre un mes sin datos y un mes en
      // blanco a propósito, y confundirlas es cómo se pierde plata acá.
      const manual = period && manualMap?.has(period.id as string)
        ? (manualMap.get(period.id as string) as number)
        : null;
      return {
        year: r.year as number,
        month: r.month as number,
        metric: r.metric as string,
        auto: r.amount === null || r.amount === undefined ? null : Number(r.amount),
        currency: (r.currency as string) ?? 'USD',
        txCount: Number(r.tx_count) || 0,
        excludedCount: Number(r.excluded_count) || 0,
        excludedAmount: Number(r.excluded_amount) || 0,
        detail: (r.detail as Record<string, unknown>) ?? null,
        computedAt: (r.computed_at as string) ?? null,
        manual,
        periodLabel: (period?.label as string) ?? null,
        periodClosed: period ? Boolean(period.is_closed) : null,
      };
    });

    // Sin Cache-Control: la respuesta lleva la columna MANUAL, que sí se
    // edita. Cachearla mostraría "guardé pero sigue viejo".
    return NextResponse.json({
      success: true,
      metrics: CRM_MONTHLY_METRIC_KEYS,
      rows,
      // Un recorte silencioso es indistinguible de "no hay más".
      truncated: rows.length >= MAX_ROWS,
    });
  } catch (err) {
    return apiError('admin/crm-monthly-totals', err, { status: 500 });
  }
}
