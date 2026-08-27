// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cron/propfirm-review
//
// Espeja la cola de retiros de prop firm y revisa los pendientes contra el
// reglamento de su programa.
//
// ── POR QUÉ ESTO EXISTE ────────────────────────────────────────────────────
// Hasta ahora la revisión dependía de que alguien se acordara: entrar a
// MetaTrader, exportar el historial de la cuenta correcta, subirlo y leer
// cinco reglas. Un retiro que nadie mirara salía sin revisar, y no había forma
// de saber cuáles habían sido.
//
// ── SU PROPIO CRON, Y NO DENTRO DEL SYNC DEL CRM ───────────────────────────
// Porque carga las aperturas de todas las cuentas de prop firm del período
// —42.914 filas— para detectar copia entre cuentas. Medido: 28 s con tres
// pendientes. Colgado del sync del CRM, que ya tiene cinco tareas dentro de un
// mismo presupuesto, lo que se caería sería el sync entero.
//
// Cada 30 minutos: los retiros de prop firm son 304 en toda la historia y hoy
// hay 3 pendientes. Correrlo cada 15 sería gastar el doble para revisar lo
// mismo dos veces.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { syncPropfirmQueue } from '@/lib/risk/propfirm-queue';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron/propfirm-review] CRON_SECRET not set');
    return NextResponse.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${expected}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();

    // Sólo las empresas que tienen Orion configurado: la cola vive allá.
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
      return NextResponse.json({ success: true, companies: 0, note: 'ninguna empresa con Orion configurado' });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const companyId of ids) {
      try {
        const r = await syncPropfirmQueue(admin, companyId);
        results.push({ companyId, ok: true, ...r });
        for (const w of r.warnings) console.warn(`[cron/propfirm-review] ${companyId}: ${w}`);
      } catch (err) {
        // Una empresa que falla no puede impedir la revisión de las demás.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cron/propfirm-review] ${companyId}: ${message}`);
        results.push({ companyId, ok: false, error: message });
      }
    }

    return NextResponse.json({ success: true, companies: ids.length, results });
  } catch (err) {
    return apiError('cron/propfirm-review', err, { status: 500 });
  }
}
