import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { fetchCoinsbuyWallets } from '@/lib/api-integrations/coinsbuy/wallets';
import { persistBalanceSnapshot } from '@/lib/api-integrations/persistence';

// ---------------------------------------------------------------------------
// GET /api/integrations/coinsbuy/wallets
//
// Returns all active Coinsbuy wallets with their confirmed balances.
// No query params needed — returns current state. Each fetch also writes a
// balance snapshot per wallet to api_balance_snapshots (append-only history).
// ---------------------------------------------------------------------------

interface WalletRow {
  id: string;
  label: string;
  currencyCode: string;
  balanceConfirmed: number;
  balancePending: number;
}

export async function GET() {
  try {
    const auth = await verifyAuth();
    if (auth instanceof NextResponse) return auth;

    const result = await fetchCoinsbuyWallets();

    // Fire-and-forget balance snapshots per wallet.
    if (result.wallets && !result.isMock) {
      Promise.all(
        (result.wallets as WalletRow[]).map((w) =>
          persistBalanceSnapshot(auth.companyId, 'coinsbuy', w.balanceConfirmed, {
            walletId: w.id,
            currency: w.currencyCode,
          }),
        ),
      ).catch((err) => console.error('[coinsbuy/wallets] snapshot failed:', err));
    }

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
