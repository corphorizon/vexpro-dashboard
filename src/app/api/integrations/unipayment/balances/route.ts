import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { fetchUnipaymentBalances } from '@/lib/api-integrations/unipayment/balances';
import { persistBalanceSnapshot } from '@/lib/api-integrations/persistence';

// ---------------------------------------------------------------------------
// GET /api/integrations/unipayment/balances
//
// Returns UniPayment wallet balances per asset type. Each successful fetch
// also writes a balance snapshot per asset to api_balance_snapshots so the
// /balances page (and any future report) can fall back to historical state
// when the live API is unreachable. Append-only — mirrors the pattern at
// /api/integrations/coinsbuy/wallets.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAuth(request);
    if (auth instanceof NextResponse) return auth;

    const result = await fetchUnipaymentBalances(auth.companyId);

    // Fire-and-forget snapshot write. Skip mock-data fetches and error
    // responses — both would pollute history with non-real balances.
    if (!result.error && result.balances.length > 0) {
      Promise.all(
        result.balances.map((b) =>
          persistBalanceSnapshot(auth.companyId, 'unipayment', b.balance, {
            walletId: b.accountId || undefined,
            currency: b.assetType,
          }),
        ),
      ).catch((err) =>
        console.error('[unipayment/balances] snapshot failed:', err),
      );
    }

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
