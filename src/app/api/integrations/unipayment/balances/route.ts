import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { fetchUnipaymentBalances } from '@/lib/api-integrations/unipayment/balances';

// ---------------------------------------------------------------------------
// GET /api/integrations/unipayment/balances
//
// Returns UniPayment wallet balances. No query params needed.
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const auth = await verifyAuth();
    if (auth instanceof NextResponse) return auth;

    const result = await fetchUnipaymentBalances();
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[UniPayment Balances] Error:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
