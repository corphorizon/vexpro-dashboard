import { NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { fetchCoinsbuyPayoutsV3 } from '@/lib/api-integrations/coinsbuy/payouts';

// ---------------------------------------------------------------------------
// GET /api/integrations/coinsbuy/payouts
//
// Query params (optional):
//   from=YYYY-MM-DDTHH:mm:ss+00:00
//   to=YYYY-MM-DDTHH:mm:ss+00:00
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  try {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;

    const url = new URL(request.url);
    const from = url.searchParams.get('from') ?? undefined;
    const to = url.searchParams.get('to') ?? undefined;
    const walletId = url.searchParams.get('walletId') ?? undefined;

    const dataset = await fetchCoinsbuyPayoutsV3({
      from,
      to,
      walletId,
      companyId: auth.companyId,
    });
    return NextResponse.json({ success: true, dataset });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[Coinsbuy Payouts] Error:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
