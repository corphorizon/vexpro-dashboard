// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cron/account-review
//
// Calcula el diagnóstico operativo de las cuentas de trading y sociales de los
// clientes que pidieron retiros instantáneos.
//
// ── POR QUÉ EXISTE ─────────────────────────────────────────────────────────
// En un retiro instantáneo el dinero YA SALIÓ sin que nadie lo mirara. Lo único
// que queda por hacer es entender cómo opera ese cliente — y hoy eso significa
// abrir MetaTrader cuenta por cuenta, que en la práctica no lo hace nadie.
//
// ── SU PROPIO CRON, Y NO DENTRO DE propfirm-review ─────────────────────────
// Comparten el calendario económico, así que la tentación era colgarlo ahí.
// No: son ~200 cuentas por corrida a ~0,28 s cada una (medido en
// mt5-sync/behavior.ts: 60 cuentas en 16,7 s emparejando por PositionID, que
// NO está en el índice) — unos 56 s que se sumarían a los 28 s que ya tarda
// aquella revisión. Separados, una caída de MT5 en medio de este cálculo no se
// lleva puesta la revisión de prop firm, que es la que decide sobre retiros
// pendientes.
//
// El calendario NO se sincroniza acá: lo mantiene fresco propfirm-review y este
// cron lo LEE del espejo. Dos escritores del mismo calendario serían dos
// ventanas distintas compitiendo por la misma tabla.
//
// Cada 30 minutos: con el techo de 200 cuentas por corrida, las ~600 candidatas
// convergen en hora y media y después se mantienen solas.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { syncAccountReviews } from '@/lib/risk/account-review-sync';
import { syncAccountCopyDetection } from '@/lib/risk/account-copy-sync';
import { loadHighImpact } from '@/lib/risk/economic-calendar';
import { apiError } from '@/lib/api-error';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron/account-review] CRON_SECRET not set');
    return NextResponse.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (request.headers.get('authorization') !== `Bearer ${expected}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();

    // Sólo las empresas con MT5 configurado: las operaciones viven allá.
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

    // ── El calendario, para la señal de noticias ────────────────────────────
    // Se LEE del espejo (lo escribe propfirm-review). Si falla, la señal queda
    // «no comprobada» en cada cuenta en vez de darse por cumplida: no tener el
    // calendario a mano no es evidencia de que el cliente no operó una noticia.
    //
    // La ventana es amplia a propósito: el alcance del diagnóstico es toda la
    // vida de la cuenta, así que se traen los últimos 180 días —lo que el
    // espejo del calendario suele cubrir— y las operaciones más viejas
    // sencillamente no encontrarán noticia cerca.
    let noticias: Awaited<ReturnType<typeof loadHighImpact>> | null = null;
    let calendarError: string | null = null;
    try {
      noticias = await loadHighImpact(
        admin,
        new Date(Date.now() - 180 * 86_400_000),
        new Date(Date.now() + 86_400_000),
      );
    } catch (err) {
      calendarError = err instanceof Error ? err.message : String(err);
      console.error(`[cron/account-review] calendario: ${calendarError}`);
    }

    // Secuencial a propósito: cada empresa abre su propio túnel a SU MT5 y
    // paralelizarlas multiplicaría las conexiones contra el hosting del broker.
    const results: Record<string, unknown>[] = [];
    for (const companyId of ids) {
      try {
        const r = await syncAccountReviews(admin, companyId, { noticias });
        for (const w of r.warnings) console.warn(`[cron/account-review] ${companyId}: ${w}`);

        // ── Fase 2: copia entre cuentas ─────────────────────────────────
        // Va DESPUÉS y sobre todas las candidatas a la vez, no dentro de la
        // rotación: la sincronía es una relación entre dos cuentas y por
        // lotes sólo se verían los pares que caen en la misma tanda.
        //
        // En su propio try/catch: si falla, el diagnóstico de la fase 1 ya
        // quedó guardado y la señal de copia se queda como estaba.
        let copia: Record<string, unknown> | null = null;
        try {
          const c = await syncAccountCopyDetection(admin, companyId);
          for (const w of c.warnings) console.warn(`[cron/account-review] copia ${companyId}: ${w}`);
          copia = { ...c };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[cron/account-review] copia ${companyId}: ${message}`);
          copia = { ok: false, error: message };
        }

        results.push({ companyId, ...r, copia });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // «Sin credenciales» no es un fallo: es una empresa que no usa MT5.
        const noConfigurado = /no configurad|not configured|sin credencial/i.test(message);
        if (!noConfigurado) console.error(`[cron/account-review] ${companyId}: ${message}`);
        results.push({ companyId, skipped: noConfigurado, error: noConfigurado ? null : message });
      }
    }

    return NextResponse.json({
      success: true,
      companies: ids.length,
      calendar: calendarError ? { ok: false, error: calendarError } : { ok: true, high: noticias?.length ?? 0 },
      results,
    });
  } catch (err) {
    return apiError('cron/account-review', err, { status: 500 });
  }
}
