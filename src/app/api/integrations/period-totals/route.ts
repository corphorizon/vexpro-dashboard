import { NextRequest, NextResponse } from 'next/server';
import { friendlyDbMessage } from '@/lib/errors';
import { verifyAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// GET /api/integrations/period-totals
//
// Returns API deposit and withdrawal totals grouped by calendar month, read
// from the persisted api_transactions table. Used by /balances to populate
// the running "Balance Actual Disponible" for derived-broker periods
// (April 2026+), where real numbers live in api_transactions instead of
// the manual `deposits` / `withdrawals` tables.
//
// Response shape:
//   {
//     success: true,
//     months: {
//       '2026-04': { deposits: 12345.67, withdrawals: 2345.67 },
//       '2026-03': { ... },
//       ...
//     }
//   }
// ---------------------------------------------------------------------------

// Kevin (2026-06-07): el código antiguo de este endpoint cargaba ALL
// `api_transactions` rows del tenant y agregaba en JS. PostgREST aplica
// un default row cap (~1000) que truncaba para tenants con muchas
// transacciones — Vex Pro tiene 5576 rows entre Mar-Jun 2026, así que
// Mayo y Junio quedaban completamente fuera del response y el gráfico
// "Evolución Mensual" mostraba ~$0 para esos meses aunque la API
// tuviera $578K + $573K reales.
//
// Reemplazado por una RPC `get_period_totals_by_month` que hace TODO el
// filtrado (status + pinned wallets) y agregado en SQL puro. Una sola
// query, sin row caps, sin paginación. Migración inline el 2026-06-07.

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAuth(request);
    if (auth instanceof NextResponse) return auth;

    const from = request.nextUrl.searchParams.get('from');
    const to = request.nextUrl.searchParams.get('to');

    const admin = createAdminClient();

    const { data, error } = await admin.rpc('get_period_totals_by_month', {
      p_company_id: auth.companyId,
      p_from: from ? `${from}T00:00:00.000Z` : '1970-01-01T00:00:00.000Z',
      p_to: to ? `${to}T23:59:59.999Z` : '2099-12-31T23:59:59.999Z',
    });

    if (error) {
      console.error('[api:integrations/period-totals]', error);
      return NextResponse.json(
        { success: false, error: friendlyDbMessage(error), months: {} },
        { status: 500 },
      );
    }

    const months: Record<string, { deposits: number; withdrawals: number }> = {};
    for (const row of (data ?? []) as Array<{
      month: string;
      deposits: number | string;
      withdrawals: number | string;
    }>) {
      months[row.month] = {
        deposits: Number(row.deposits) || 0,
        withdrawals: Number(row.withdrawals) || 0,
      };
    }

    return NextResponse.json({ success: true, months });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[period-totals] Unhandled error:', message);
    return NextResponse.json(
      { success: false, error: friendlyDbMessage(err), months: {} },
      { status: 500 },
    );
  }
}
