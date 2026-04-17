import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { fetchCoinsbuyWallets } from '@/lib/api-integrations/coinsbuy/wallets';

// ---------------------------------------------------------------------------
// GET /api/integrations/coinsbuy/wallets
//
// Returns all active Coinsbuy wallets with their confirmed balances.
// No query params needed — returns current state.
// ---------------------------------------------------------------------------

export async function GET() {
  try {
    const auth = await verifyAuth();
    if (auth instanceof NextResponse) return auth;

    const result = await fetchCoinsbuyWallets();
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[Coinsbuy Wallets] Error:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
