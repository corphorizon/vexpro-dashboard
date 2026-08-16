import { NextRequest, NextResponse } from 'next/server';
import { privateCache } from '@/lib/cache-headers';
import { friendlyDbMessage } from '@/lib/errors';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { fetchFairpayDeposits } from '@/lib/api-integrations/fairpay/transactions';

// ---------------------------------------------------------------------------
// GET /api/integrations/fairpay/transactions
//
// Query params (optional):
//   from=YYYY-MM-DD
//   to=YYYY-MM-DD
//
// Server-side proxy — credentials never reach the browser.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    // Gate de ROL agregado en la auditoría: este proxy devuelve las
    // transacciones crudas de la pasarela y estaba abierto a CUALQUIER rol
    // (invitado incluido), mientras el equivalente de Coinsbuy ya exigía
    // FINANCE_ROLES. Ninguna pantalla lo consume — se usa para diagnóstico.
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['movements'] });
    if (auth instanceof NextResponse) return auth;

    const from = request.nextUrl.searchParams.get('from') ?? undefined;
    const to = request.nextUrl.searchParams.get('to') ?? undefined;

    const dataset = await fetchFairpayDeposits({ from, to, companyId: auth.companyId });
    return NextResponse.json({ success: true, dataset }, { headers: privateCache() });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[FairPay Transactions] Error:', message);
    return NextResponse.json(
      { success: false, error: friendlyDbMessage(err) },
      { status: 500 },
    );
  }
}
