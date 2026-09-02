// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/hedge-fund/overview
//
// Todo lo que la pestaña «Resumen» y la pestaña «Programas» necesitan, en UNA
// llamada: los agregados globales, el desglose por programa, el estado del
// espejo y cuántas filas de prueba se dejaron afuera.
//
// ── EL CAPITAL VA POR APARTE ───────────────────────────────────────────────
// Kevin, 2026-09-02: estos números NO se integran a balances, ni al resumen
// general, ni a la cadena de distribución. Esta ruta no lee ni escribe una sola
// tabla contable, y no debería empezar a hacerlo sin una decisión explícita —
// tocar la cadena recalcula retroactivamente períodos ya cerrados (§2.3).
//
// Auth: el MÓDULO decide quién lee (§4.1). `company_id` sale del token y va
// explícito en cada consulta porque el admin client no pasa por RLS (§4.2).
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { buildFundSummaries, buildOverview } from '@/lib/hedge-fund/aggregate';
import { mirrorIsStale, readHedgeFundMirror } from '@/lib/hedge-fund/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAuth(request, { modules: ['hedge_fund'] });
  if (auth instanceof NextResponse) return auth;

  try {
    const admin = createAdminClient();
    const mirror = await readHedgeFundMirror(admin, auth.companyId, {
      funds: true, investments: true, ledger: true, payouts: true, commissions: true,
    });

    return NextResponse.json({
      success: true,
      overview: buildOverview({
        investments: mirror.investments,
        ledger: mirror.ledger,
        commissions: mirror.commissions,
      }),
      funds: buildFundSummaries({
        funds: mirror.funds,
        investments: mirror.investments,
        ledger: mirror.ledger,
        payouts: mirror.payouts,
      }),
      // Contado y visible. La pantalla dibuja «N excluidos (pruebas)».
      excluded: mirror.excluded,
      // `null` = nunca se sincronizó. No es «hace mucho»: es «no hay espejo».
      lastSyncedAt: mirror.lastSyncedAt,
      stale: mirrorIsStale(mirror.lastSyncedAt),
    });
  } catch (err) {
    return apiError('admin/hedge-fund/overview', err, { status: 500 });
  }
}
