import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { fetchOrionCrmTotals } from '@/lib/api-integrations/orion-crm/totals';

// ---------------------------------------------------------------------------
// GET /api/integrations/orion-crm/totals?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Server-side proxy for the client hook `useOrionCrmTotals`. Keeps the
// API key off the browser and lets us swap the real CRM endpoint in
// without touching the React tree.
//
// Returns the `OrionCrmTotals` shape directly (no `{ success: … }` wrap)
// so the hook can consume the payload verbatim.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAuth(request);
    if (auth instanceof NextResponse) return auth;

    const from = request.nextUrl.searchParams.get('from') ?? '';
    const to = request.nextUrl.searchParams.get('to') ?? '';

    const totals = await fetchOrionCrmTotals(auth.companyId, from, to);
    return NextResponse.json(totals);
  } catch (err) {
    console.error('[orion-crm/totals] unhandled:', err);
    return NextResponse.json(
      {
        propFirmSales: 0,
        p2pTransfer: 0,
        connected: false,
        isMock: false,
        lastSync: null,
        errorMessage: 'Error interno',
      },
      { status: 500 },
    );
  }
}
