// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cron/notification-sweep
//
// Los otros avisos nacen de un evento (una orden se aprueba, un sync falla).
// Estos dos NO tienen evento: nacen del PASO DEL TIEMPO. Una orden aprobada se
// vuelve un problema porque nadie la pagó, y un período se vuelve un problema
// porque nadie lo cerró — en los dos casos el hecho que hay que avisar es que
// no pasó nada. Sin un barrido diario no existe el momento en que emitirlos.
//
// El dedupe por día (dailyKey) es lo que hace que esto no sea spam: mientras el
// aviso siga sin leerse no se repite, y si el pendiente sigue mañana vuelve a
// avisar una sola vez.
//
// Auth: `Authorization: Bearer <CRON_SECRET>`, igual que el resto de /api/cron.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { notify, dailyKey } from '@/lib/notifications/notify';

/** Antigüedad a partir de la cual una orden aprobada y sin pagar preocupa. */
const UNPAID_DAYS = 3;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  if (!expected) {
    // Fail closed — nunca correr sin secreto explícito.
    console.error('[cron/notification-sweep] CRON_SECRET env var not set');
    return NextResponse.json(
      { success: false, error: 'CRON_SECRET not configured' },
      { status: 500 },
    );
  }

  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: companies, error: listError } = await admin
    .from('companies')
    .select('id, name')
    .eq('status', 'active');

  if (listError || !companies) {
    return NextResponse.json(
      { success: false, error: listError?.message ?? 'No companies' },
      { status: 500 },
    );
  }

  const cutoff = new Date(Date.now() - UNPAID_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;

  const sweepOneCompany = async (company: { id: string; name: string }) => {
    const entry: Record<string, unknown> = { company_id: company.id, company_name: company.name };

    // ── Órdenes aprobadas sin pagar ──
    try {
      const { data, error } = await admin
        .from('payment_orders')
        .select('id, total')
        .eq('company_id', company.id)
        .eq('status', 'approved')
        .is('paid_at', null)
        .lt('approved_at', cutoff);
      if (error) throw new Error(error.message);

      const orders = (data ?? []) as Array<{ total: number | null }>;
      if (orders.length > 0) {
        const total = orders.reduce((s, o) => s + Number(o.total ?? 0), 0);
        await notify(admin, {
          companyId: company.id,
          type: 'order.approved_unpaid',
          params: { count: orders.length, amount: total.toFixed(2) },
          link: '/ordenes-pago',
          dedupeKey: dailyKey(`unpaid:${company.id}`),
        });
      }
      entry.approved_unpaid = orders.length;
    } catch (err) {
      entry.approved_unpaid_error = err instanceof Error ? err.message : 'Unknown error';
    }

    // ── Períodos de meses anteriores que siguen abiertos ──
    try {
      const { data, error } = await admin
        .from('periods')
        .select('id, year, month, label')
        .eq('company_id', company.id)
        .eq('is_closed', false)
        // "Anterior al mes actual": el mes en curso se cierra recién cuando
        // termina, así que avisar por él sería avisar todos los días por algo
        // que todavía no se puede hacer.
        .or(`year.lt.${year},and(year.eq.${year},month.lt.${month})`);
      if (error) throw new Error(error.message);

      const periods = (data ?? []) as Array<{
        id: string; year: number; month: number; label: string | null;
      }>;
      for (const p of periods) {
        await notify(admin, {
          companyId: company.id,
          type: 'period.still_open',
          params: { label: p.label || `${p.year}-${String(p.month).padStart(2, '0')}` },
          link: '/periodos',
          dedupeKey: dailyKey(`openperiod:${company.id}:${p.id}`),
        });
      }
      entry.periods_open = periods.length;
    } catch (err) {
      entry.periods_open_error = err instanceof Error ? err.message : 'Unknown error';
    }

    return entry;
  };

  const results = await Promise.all(companies.map(sweepOneCompany));

  return NextResponse.json({
    success: true,
    companies_processed: results.length,
    results,
  });
}
