// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cron/mt5-pnl
//
// Foto del PNL abierto y del PNL cerrado del día, por categoría de cuenta.
//
// ── POR QUÉ TIENE SU PROPIO CRON Y NO VA COLGADO DEL SYNC DEL CRM ──────────
// Porque el costo crece a lo largo del día. Medido el 2026-08-26:
//
//     PNL abierto                    275 ms
//     PNL cerrado, día recién empezado   748 ms
//     PNL cerrado, día completo         26 s
//
// El sync del CRM ya hace Orion + Pay-Pros + MT5 + agregados dentro de un
// mismo presupuesto de función. Meterle 26 s más al final del día lo llevaría
// al límite justo cuando más datos tiene que escribir, y lo que se caería
// sería el sync entero, no el PNL.
//
// ── PARA QUÉ SE GUARDA SI SE PODRÍA CONSULTAR AL VUELO ─────────────────────
// Porque el PNL cerrado del día deja de ser consultable en cuanto el día pasa:
// MetaTrader no guarda "cómo cerró el martes", guarda deals. Reconstruir un día
// viejo cuesta los mismos 26 s cada vez que alguien lo mire. La foto es lo que
// hace que el histórico se pueda buscar por fecha sin volver a MySQL.
//
// Se reescribe la fila del día en cada corrida (misma clave
// `company_id + snapshot_at + category`), así que el último snapshot de un día
// pasado es su cierre definitivo.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { syncMt5Pnl } from '@/lib/mt5-sync/pnl';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron/mt5-pnl] CRON_SECRET not set');
    return NextResponse.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${expected}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();

    // `day` permite rellenar un día que no se llegó a fotografiar (por ejemplo
    // tras una caída). Sin él, ese día quedaría vacío para siempre.
    const day = request.nextUrl.searchParams.get('day');
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return NextResponse.json(
        { success: false, error: 'El parámetro `day` debe ser YYYY-MM-DD.' },
        { status: 400 },
      );
    }

    const { data: creds, error: credsErr } = await admin
      .from('api_credentials')
      .select('company_id')
      .eq('provider', 'mt5_sql')
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
      return NextResponse.json({ success: true, companies: 0, note: 'ninguna empresa con MT5 configurado' });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const companyId of ids) {
      try {
        const r = await syncMt5Pnl(admin, companyId, day ? { day } : {});
        results.push({ companyId, ok: true, ...r });
        for (const w of r.warnings) console.warn(`[cron/mt5-pnl] ${companyId}: ${w}`);
      } catch (err) {
        // Una empresa que falla no puede impedir la foto de las demás.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[cron/mt5-pnl] ${companyId}: ${message}`);
        results.push({ companyId, ok: false, error: message });
      }
    }

    return NextResponse.json({ success: true, companies: ids.length, results });
  } catch (err) {
    return apiError('cron/mt5-pnl', err, { status: 500 });
  }
}
