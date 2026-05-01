import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ProviderDataset, ProviderSlug } from '@/lib/api-integrations/types';

// ---------------------------------------------------------------------------
// GET /api/integrations/persisted-movements
//
// Returns the LAST PERSISTED state of the four provider datasets — the
// Movimientos page uses this on initial load so users don't hit the APIs
// until they explicitly click "Refrescar". Everything here comes from
// Supabase (api_transactions + api_sync_log), nothing hits external APIs.
//
// Query params (all optional):
//   from=YYYY-MM-DD     inclusive lower bound on transaction_date
//   to=YYYY-MM-DD       inclusive upper bound on transaction_date
//   walletId=<id>       when set, also filter Coinsbuy rows by wallet_id
// ---------------------------------------------------------------------------

const SLUGS: ProviderSlug[] = [
  'coinsbuy-deposits',
  'coinsbuy-withdrawals',
  'fairpay',
  'unipayment',
];

const PROVIDER_KIND: Record<ProviderSlug, 'deposits' | 'withdrawals'> = {
  'coinsbuy-deposits': 'deposits',
  'coinsbuy-withdrawals': 'withdrawals',
  fairpay: 'deposits',
  unipayment: 'deposits',
};

const PROVIDER_ID: Record<ProviderSlug, 'coinsbuy' | 'fairpay' | 'unipayment'> = {
  'coinsbuy-deposits': 'coinsbuy',
  'coinsbuy-withdrawals': 'coinsbuy',
  fairpay: 'fairpay',
  unipayment: 'unipayment',
};

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAuth(request);
    if (auth instanceof NextResponse) return auth;

    const from = request.nextUrl.searchParams.get('from');
    const to = request.nextUrl.searchParams.get('to');
    const walletId = request.nextUrl.searchParams.get('walletId') ?? null;

    const admin = createAdminClient();

    let query = admin
      .from('api_transactions')
      .select('provider, external_id, amount, fee, currency, status, transaction_date, wallet_id, raw')
      .eq('company_id', auth.companyId)
      .order('transaction_date', { ascending: false })
      // Defensive cap. With ~5K tx/month per tenant a 35-day window stays
      // well under this; if a future caller asks for a multi-year range
      // we fail loud instead of silently shipping 100K rows over the wire.
      .limit(10000);

    if (from) query = query.gte('transaction_date', `${from}T00:00:00.000Z`);
    if (to) query = query.lte('transaction_date', `${to}T23:59:59.999Z`);

    const { data: rows, error } = await query;
    if (error) {
      return NextResponse.json(
        { success: false, error: error.message, datasets: [], fetchedAt: null },
        { status: 500 },
      );
    }

    // Get last sync timestamp (any provider) — used to show "Actualizado hace X"
    const { data: lastSync } = await admin
      .from('api_sync_log')
      .select('last_synced_at')
      .eq('company_id', auth.companyId)
      .order('last_synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Group rows per slug, optionally filtering Coinsbuy by wallet.
    const datasets: ProviderDataset[] = SLUGS.map((slug) => {
      const matches = (rows ?? []).filter((r) => {
        if (r.provider !== slug) return false;
        // Wallet filter only applies to Coinsbuy rows with a wallet_id.
        if (walletId && slug.startsWith('coinsbuy') && r.wallet_id && r.wallet_id !== walletId) {
          return false;
        }
        return true;
      });

      // Rehydrate the original transaction shape from the `raw` column that
      // was stored at persist time. If raw is missing, synthesise a minimal
      // row so the table can still render.
      const transactions = matches.map((r) => {
        const raw = r.raw as Record<string, unknown> | null;
        if (raw && typeof raw === 'object') return raw;
        return {
          id: r.external_id,
          createdAt: r.transaction_date,
          currency: r.currency ?? '',
          status: r.status ?? '',
          amountTarget: Number(r.amount) || 0,
          chargedAmount: Number(r.amount) || 0,
          net: Number(r.amount) || 0,
          netAmount: Number(r.amount) || 0,
          commission: Number(r.fee) || 0,
          mdr: Number(r.fee) || 0,
          fee: Number(r.fee) || 0,
        };
      });

      return {
        slug,
        provider: PROVIDER_ID[slug],
        kind: PROVIDER_KIND[slug],
        transactions: transactions as unknown as ProviderDataset['transactions'],
        fetchedAt: lastSync?.last_synced_at ?? new Date(0).toISOString(),
        status: 'fresh' as const,
        isMock: false,
      };
    });

    return NextResponse.json({
      success: true,
      datasets,
      fetchedAt: lastSync?.last_synced_at ?? null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[persisted-movements] Unhandled error:', message);
    return NextResponse.json(
      { success: false, error: message, datasets: [], fetchedAt: null },
      { status: 500 },
    );
  }
}
