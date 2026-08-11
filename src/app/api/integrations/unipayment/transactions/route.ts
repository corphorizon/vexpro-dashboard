import { NextRequest, NextResponse } from 'next/server';
import { privateCache } from '@/lib/cache-headers';
import { friendlyDbMessage } from '@/lib/errors';
import { verifyAdminAuth, FINANCE_ROLES } from '@/lib/api-auth';
import { fetchUnipaymentDepositsV2 } from '@/lib/api-integrations/unipayment/transactions';

// ---------------------------------------------------------------------------
// GET /api/integrations/unipayment/transactions
//
// Query params (optional):
//   from=YYYY-MM-DD
//   to=YYYY-MM-DD
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    // Gate de ROL agregado en la auditoría: mismo criterio que
    // coinsbuy/deposits — transacciones crudas de la pasarela no son lectura
    // para cualquier rol. Ninguna pantalla lo consume (diagnóstico).
    const auth = await verifyAdminAuth(request, { roles: FINANCE_ROLES, modules: ['movements'] });
    if (auth instanceof NextResponse) return auth;

    const from = request.nextUrl.searchParams.get('from') ?? undefined;
    const to = request.nextUrl.searchParams.get('to') ?? undefined;

    const dataset = await fetchUnipaymentDepositsV2({ from, to, companyId: auth.companyId });
    return NextResponse.json({ success: true, dataset }, { headers: privateCache() });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[UniPayment Transactions] Error:', message);
    return NextResponse.json(
      { success: false, error: friendlyDbMessage(err) },
      { status: 500 },
    );
  }
}
