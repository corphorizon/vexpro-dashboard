// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cron/sync-health
//
// Avisa si el sync del CRM dejó de correr.
//
// ── POR QUÉ ESTO EXISTE ────────────────────────────────────────────────────
// Porque la muerte de ese sync es INVISIBLE. El traspaso a Retención se
// dispara desde dentro de él —cuando el contador de depósitos de un cliente
// pasa de cero a uno—, así que si deja de correr:
//
//   · nadie pasa a Retención,
//   · ningún proceso da error,
//   · el único síntoma es una cola que se queda vacía,
//   · y nadie mira una cola vacía pensando "esto está roto".
//
// Mientras Atlas tenía su propia conexión a Orion, un fallo nuestro no les
// afectaba. Cuando consuman de nosotros, este aviso pasa de deuda a requisito.
//
// ── EL UMBRAL Y POR QUÉ NO ES 15 MINUTOS ───────────────────────────────────
// El sync corre cada 15 min. Avisar al primer hueco convertiría la alerta en
// ruido: un despliegue, un pico del broker o un reintento la dispararían a
// diario, y una alerta que suena todos los días deja de leerse. Se avisa a los
// 60 minutos — cuatro corridas perdidas — que ya no se explica por un tropiezo.
//
// ── SE MIDE LA ÚLTIMA CORRIDA, NO EL ÚLTIMO ÉXITO TOTAL ────────────────────
// Una corrida que terminó con errores parciales igual escribió su registro y
// vale como señal de vida: el proceso está en pie. Lo que esta alerta detecta
// es que NO HAY NADA, que es el fallo que nadie ve.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { notify, dailyKey } from '@/lib/notifications/notify';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Módulo con el que `crm-sync` firma sus corridas en audit_logs. */
const AUDIT_MODULE = 'crm_sync';

/** Cuatro corridas perdidas. Ver la cabecera. */
const STALE_MINUTES = 60;

interface CompanyRow {
  id: string;
  name: string | null;
}

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron/sync-health] CRON_SECRET not set');
    return NextResponse.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${expected}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();

    // Sólo las empresas que TIENEN el sync configurado. Avisar de un sync que
    // nunca existió sería ruido puro.
    const { data: creds, error: credsErr } = await admin
      .from('api_credentials')
      .select('company_id')
      .eq('provider', 'orion_mongo')
      .eq('is_configured', true);
    if (credsErr) throw new Error(`api_credentials: ${credsErr.message}`);

    const ids = [
      ...new Set(
        (creds ?? [])
          .map((r) => (typeof r.company_id === 'string' ? r.company_id : null))
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    if (ids.length === 0) {
      return NextResponse.json({ success: true, checked: 0, stale: [], note: 'ninguna empresa con el sync configurado' });
    }

    const { data: companies, error: cErr } = await admin
      .from('companies')
      .select('id, name, status')
      .in('id', ids)
      .neq('status', 'inactive');
    if (cErr) throw new Error(`companies: ${cErr.message}`);

    const corte = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
    const results: Array<{ company: string | null; lastRunAt: string | null; minutesAgo: number | null; stale: boolean }> = [];

    for (const c of (companies ?? []) as unknown as CompanyRow[]) {
      const { data: last, error: lErr } = await admin
        .from('audit_logs')
        .select('created_at')
        .eq('company_id', c.id)
        .eq('module', AUDIT_MODULE)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lErr) throw new Error(`audit_logs ${c.id}: ${lErr.message}`);

      const lastRunAt = last?.created_at ? String(last.created_at) : null;
      const minutesAgo = lastRunAt
        ? Math.round((Date.now() - new Date(lastRunAt).getTime()) / 60000)
        : null;

      // Sin ninguna corrida registrada también es un fallo: significa que el
      // sync nunca arrancó desde que se configuró.
      const stale = lastRunAt === null || lastRunAt < corte;
      results.push({ company: c.name, lastRunAt, minutesAgo, stale });

      if (stale) {
        console.error(
          `[cron/sync-health] ${c.name ?? c.id}: sin corridas desde ${lastRunAt ?? 'nunca'}`,
        );
        await notify(admin, {
          companyId: c.id,
          type: 'crm_sync.stale',
          params: {
            minutes: minutesAgo ?? STALE_MINUTES,
            company: c.name ?? '—',
          },
          link: '/risk/retiros',
          // Por día: un sync caído no debe generar 24 avisos idénticos, pero
          // mañana vuelve a avisar si sigue caído.
          dedupeKey: dailyKey(`crm-sync-stale:${c.id}`),
        });
      }
    }

    return NextResponse.json({
      success: true,
      thresholdMinutes: STALE_MINUTES,
      checked: results.length,
      stale: results.filter((r) => r.stale),
      results,
    });
  } catch (err) {
    return apiError('cron/sync-health', err, { status: 500 });
  }
}
