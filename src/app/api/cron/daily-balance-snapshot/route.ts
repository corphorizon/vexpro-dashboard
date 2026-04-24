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

  // Parallel per-tenant snapshot.
  //
  // Old code iterated companies sequentially with two awaits per iteration,
  // so total time grew linearly: ~3s × N companies. At 20 tenants that was
  // already ~60s and approached Vercel Pro's 300s function-timeout cliff.
  //
  // Promise.all over the whole list fans out per-tenant work concurrently.
  // Each tenant still runs Coinsbuy + UniPayment sequentially (they share
  // DNS resolution work and IPv4-first side effect setup, so parallelising
  // within a tenant offered marginal gain and risked rate-limiting the
  // same global account today).
  //
  // Every tenant's work is wrapped in its own try/catch so one API blip
  // doesn't take down the whole run — each tenant reports its own errors
  // in the `results` array.
  const snapshotOneCompany = async (company: { id: string; name: string }) => {
    const entry: Record<string, unknown> = {
      company_id: company.id,
      company_name: company.name,
    };

    // ── Coinsbuy ──
    // Pass company.id so the fetcher picks up per-tenant credentials from
    // api_credentials (falling back to env when that tenant hasn't uploaded
    // its own). Same resolution the interactive endpoints use.
    //
    // We write TWO kinds of snapshot so the UI + email match the /balances
    // page granularity:
    //   1. Aggregate row `coinsbuy` with the sum of the PINNED wallets only
    //      (not all wallets returned by the API — the page also scopes to
    //      the pinned set). Keeps backwards compat for readers that only
    //      care about the total.
    //   2. One row per pinned wallet with channel_key `coinsbuy:<wallet_id>`
    //      and the individual balance. The report builder reads these and
    //      expands the `coinsbuy` channel into per-wallet rows.
    try {
      const cb = await fetchCoinsbuyWallets(company.id);
      if (cb.error) {
        entry.coinsbuy_error = cb.error;
      } else {
        // Load pinned wallet selection for this tenant.
        const { data: pinned } = await admin
          .from('pinned_coinsbuy_wallets')
          .select('wallet_id, wallet_label')
          .eq('company_id', company.id);
        const pins = pinned ?? [];
        const wallets = cb.wallets ?? [];

        // Per-wallet snapshots (only for pinned ones).
        let pinnedTotal = 0;
        const perWallet: Record<string, number> = {};
        for (const p of pins) {
          const w = wallets.find((x) => x.id === p.wallet_id);
          const amt = w?.balanceConfirmed ?? 0;
          pinnedTotal += amt;
          perWallet[p.wallet_id] = amt;
          await upsertChannelBalance(
            company.id,
            today,
            `coinsbuy:${p.wallet_id}`,
            amt,
            'api',
          );
        }

        // Aggregate row. If no wallets are pinned, fall back to the sum of
        // ALL wallets so tenants that haven't configured pinning still get
        // a number in the report.
        const totalForAggregate =
          pins.length > 0
            ? pinnedTotal
            : wallets.reduce((s, w) => s + (w.balanceConfirmed || 0), 0);
        await upsertChannelBalance(company.id, today, 'coinsbuy', totalForAggregate, 'api');
        entry.coinsbuy = totalForAggregate;
        entry.coinsbuy_pinned_wallets = perWallet;
      }
    } catch (err) {
      entry.coinsbuy_error = err instanceof Error ? err.message : 'Unknown error';
    }

    // ── UniPayment ──
    try {
      const up = await fetchUnipaymentBalances(company.id);
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

    return entry;
  };

  const results = await Promise.all(companies.map(snapshotOneCompany));

  return NextResponse.json({
    success: true,
    snapshot_date: today,
    companies_processed: results.length,
    results,
  });
}
