import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCoinsbuyWallets } from '@/lib/api-integrations/coinsbuy/wallets';
import { fetchUnipaymentBalances } from '@/lib/api-integrations/unipayment/balances';
import { upsertChannelBalance } from '@/lib/supabase/mutations';

// ---------------------------------------------------------------------------
// GET /api/cron/daily-balance-snapshot
//
// Vercel Cron hits this every day at 00:00 UTC (see vercel.json). It captures
// "how the previous day closed" for every company by upserting one row per
// (company, channel) into channel_balances with snapshot_date = today (UTC).
//
// Rationale: liquidez/inversiones can be reconstructed from movements, but
// Coinsbuy / UniPayment balances are point-in-time readings of the external
// API — without a snapshot we can't look up "what was my balance on Apr 5".
//
// Auth: Vercel sends `Authorization: Bearer <CRON_SECRET>` automatically
// when CRON_SECRET env var is set. Requests without that header are 401.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  if (!expected) {
    // Fail closed — never run without an explicit secret.
    console.error('[cron/daily-balance-snapshot] CRON_SECRET env var not set');
    return NextResponse.json(
      { success: false, error: 'CRON_SECRET not configured' },
      { status: 500 },
    );
  }

  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 },
    );
  }

  const admin = createAdminClient();

  // Snapshot date = today in UTC. This captures the end of the previous
  // day when the cron runs at 00:00 UTC, since nothing has changed yet.
  // Users querying "show me 2026-04-18" will get the row written at the
  // very start of 2026-04-19 (≡ end of 2026-04-18).
  const today = new Date().toISOString().slice(0, 10);

  const { data: companies, error: listError } = await admin
    .from('companies')
    .select('id, name');

  if (listError || !companies) {
    return NextResponse.json(
      { success: false, error: listError?.message ?? 'No companies' },
      { status: 500 },
    );
  }

  const results: Array<Record<string, unknown>> = [];

  for (const company of companies) {
    const entry: Record<string, unknown> = {
      company_id: company.id,
      company_name: company.name,
    };

    // ── Coinsbuy ──
    try {
      const cb = await fetchCoinsbuyWallets();
      if (cb.error) {
        entry.coinsbuy_error = cb.error;
      } else {
        const total = (cb.wallets ?? []).reduce(
          (s, w) => s + (w.balanceConfirmed || 0),
          0,
        );
        await upsertChannelBalance(company.id, today, 'coinsbuy', total, 'api');
        entry.coinsbuy = total;
      }
    } catch (err) {
      entry.coinsbuy_error = err instanceof Error ? err.message : 'Unknown error';
    }

    // ── UniPayment ──
    try {
      const up = await fetchUnipaymentBalances();
      if (up.error) {
        entry.unipayment_error = up.error;
      } else {
        const total = (up.balances ?? []).reduce(
          (s, b: { availableBalance?: number }) => s + (b.availableBalance ?? 0),
          0,
        );
        await upsertChannelBalance(company.id, today, 'unipayment', total, 'api');
        entry.unipayment = total;
      }
    } catch (err) {
      entry.unipayment_error = err instanceof Error ? err.message : 'Unknown error';
    }

    results.push(entry);
  }

  return NextResponse.json({
    success: true,
    snapshot_date: today,
    companies_processed: results.length,
    results,
  });
}
