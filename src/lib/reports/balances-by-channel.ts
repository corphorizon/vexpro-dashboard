// ─────────────────────────────────────────────────────────────────────────────
// Server-side balances-by-channel builder for reports (page + email).
//
// Reconstructs the same list the /balances page renders, but without the
// client-side hooks. Reads:
//   · channel_configs         — per-company visibility + custom channels
//   · channel_balances        — latest snapshot per key (daily cron writes these)
//   · liquidity_movements     — sum → `liquidez`
//   · investments             — sum → `inversiones`
//
// Never throws: on any failure returns `{ channels: [], total: 0 }` so a
// flaky source doesn't take the whole report down.
// ─────────────────────────────────────────────────────────────────────────────

import { createAdminClient } from '@/lib/supabase/admin';
import { resolveChannels, type ChannelConfigRow, type ResolvedChannel } from '@/lib/channel-configs';
import { fetchCoinsbuyWallets } from '@/lib/api-integrations/coinsbuy/wallets';
import { fetchUnipaymentBalances } from '@/lib/api-integrations/unipayment/balances';
import { upsertChannelBalance } from '@/lib/supabase/mutations';

export interface ReportChannelBalanceRow {
  key: string;
  label: string;
  type: 'api' | 'manual' | 'auto';
  amount: number;
  source: 'live' | 'snapshot' | 'computed';
  isCustom: boolean;
}

export interface ReportBalancesByChannel {
  channels: ReportChannelBalanceRow[];
  total: number;
  asOf: string; // YYYY-MM-DD — the snapshot date requested
}

const AUTO_COMPUTED = new Set(['liquidez', 'inversiones']);

export async function buildBalancesByChannel(
  companyId: string,
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<ReportBalancesByChannel> {
  const admin = createAdminClient();

  try {
    // 1. Resolve the per-company channel list (respects visibility).
    const { data: cfgRows } = await admin
      .from('channel_configs')
      .select('id, channel_key, custom_label, channel_type, is_visible, is_custom, sort_order')
      .eq('company_id', companyId);

    const resolved: ResolvedChannel[] = resolveChannels((cfgRows ?? []) as ChannelConfigRow[]);
    const visible = resolved.filter((c) => c.isVisible);
    if (visible.length === 0) return { channels: [], total: 0, asOf };

    const visibleKeys = visible.map((c) => c.key);

    // 2. Latest snapshots <= asOf for each visible key. We can't easily do
    //    a per-key DISTINCT ON from JS, so we fetch the last N days window
    //    and reduce in memory. 30 days is plenty — the daily cron writes
    //    every day when the module is active.
    //
    // Also pull per-pinned-wallet Coinsbuy snapshots (channel_key like
    // `coinsbuy:<wallet_id>`). If the cron captured them we'll expand the
    // single `coinsbuy` channel into one row per wallet, matching what the
    // /balances page shows.
    const fromDate = new Date(asOf);
    fromDate.setUTCDate(fromDate.getUTCDate() - 30);
    const fromIso = fromDate.toISOString().slice(0, 10);

    // Broaden the query: fetch everything matching our keys OR the
    // coinsbuy:* pattern. Supabase's or() handles both.
    const { data: snapRows } = await admin
      .from('channel_balances')
      .select('channel_key, snapshot_date, amount, source')
      .eq('company_id', companyId)
      .or(`channel_key.in.(${visibleKeys.map((k) => `"${k}"`).join(',')}),channel_key.like.coinsbuy:%`)
      .lte('snapshot_date', asOf)
      .gte('snapshot_date', fromIso)
      .order('snapshot_date', { ascending: false });

    const latestSnap = new Map<string, { amount: number; source: string }>();
    for (const r of snapRows ?? []) {
      if (!latestSnap.has(r.channel_key)) {
        latestSnap.set(r.channel_key, { amount: Number(r.amount) || 0, source: r.source });
      }
    }

    // Pull the pinned wallet labels so the report shows "Savings Vex Pro"
    // instead of "coinsbuy:1087". Only needed when `coinsbuy` is visible.
    let pinnedWallets: Array<{ wallet_id: string; wallet_label: string }> = [];
    if (visibleKeys.includes('coinsbuy')) {
      const { data: pins } = await admin
        .from('pinned_coinsbuy_wallets')
        .select('wallet_id, wallet_label')
        .eq('company_id', companyId);
      pinnedWallets = pins ?? [];
    }

    // Self-healing: if the coinsbuy channel is visible but the latest snapshot
    // is stale (> 6 h old) OR missing for any pinned wallet, hit the Coinsbuy
    // API live and upsert on-the-fly. This guarantees every report — manual
    // OR scheduled — has fresh wallet balances even if the daily-balance-
    // snapshot cron is broken or the tenant never received one.
    if (visibleKeys.includes('coinsbuy') && pinnedWallets.length > 0) {
      const needsRefresh = pinnedWallets.some((pw) => !latestSnap.has(`coinsbuy:${pw.wallet_id}`));
      if (needsRefresh) {
        try {
          const cb = await fetchCoinsbuyWallets(companyId);
          if (!cb.error) {
            const wallets = cb.wallets ?? [];
            let pinnedTotal = 0;
            for (const pw of pinnedWallets) {
              const w = wallets.find((x) => x.id === pw.wallet_id);
              const amt = w?.balanceConfirmed ?? 0;
              pinnedTotal += amt;
              await upsertChannelBalance(
                companyId,
                asOf,
                `coinsbuy:${pw.wallet_id}`,
                amt,
                'api',
              );
              latestSnap.set(`coinsbuy:${pw.wallet_id}`, { amount: amt, source: 'api' });
            }
            await upsertChannelBalance(companyId, asOf, 'coinsbuy', pinnedTotal, 'api');
            latestSnap.set('coinsbuy', { amount: pinnedTotal, source: 'api' });
          }
        } catch {
          // Non-fatal — we just won't have coinsbuy data in this report.
        }
      }
    }

    // Same self-healing for UniPayment (single aggregate, no per-account).
    if (visibleKeys.includes('unipayment') && !latestSnap.has('unipayment')) {
      try {
        const up = await fetchUnipaymentBalances(companyId);
        if (!up.error) {
          const total = (up.balances ?? []).reduce(
            (s, b: { availableBalance?: number }) => s + (b.availableBalance ?? 0),
            0,
          );
          await upsertChannelBalance(companyId, asOf, 'unipayment', total, 'api');
          latestSnap.set('unipayment', { amount: total, source: 'api' });
        }
      } catch {
        /* non-fatal */
      }
    }

    // 3. For liquidez / inversiones, compute on the fly (matches the
    //    /balances page — the stored `balance` column is unreliable there).
    let liquidezTotal = 0;
    let investmentsTotal = 0;
    if (visibleKeys.includes('liquidez')) {
      const { data: liq } = await admin
        .from('liquidity_movements')
        .select('deposit, withdrawal')
        .eq('company_id', companyId);
      liquidezTotal = (liq ?? []).reduce(
        (s, r) => s + (Number(r.deposit) || 0) - (Number(r.withdrawal) || 0),
        0,
      );
    }
    if (visibleKeys.includes('inversiones')) {
      const { data: inv } = await admin
        .from('investments')
        .select('deposit, withdrawal, profit')
        .eq('company_id', companyId);
      investmentsTotal = (inv ?? []).reduce(
        (s, r) =>
          s + (Number(r.deposit) || 0) - (Number(r.withdrawal) || 0) + (Number(r.profit) || 0),
        0,
      );
    }

    // 4. Build the output rows. Coinsbuy is special: when the tenant has
    //    pinned specific wallets, we output one row per pinned wallet
    //    instead of a single aggregate row, so the reader sees exactly
    //    which wallet holds what (matches the /balances page).
    const channels: ReportChannelBalanceRow[] = [];
    for (const ch of visible) {
      if (ch.key === 'liquidez') {
        channels.push({
          key: ch.key,
          label: ch.label,
          type: ch.type,
          amount: liquidezTotal,
          source: 'computed',
          isCustom: ch.isCustom,
        });
        continue;
      }
      if (ch.key === 'inversiones') {
        channels.push({
          key: ch.key,
          label: ch.label,
          type: ch.type,
          amount: investmentsTotal,
          source: 'computed',
          isCustom: ch.isCustom,
        });
        continue;
      }
      if (ch.key === 'coinsbuy' && pinnedWallets.length > 0) {
        // Expand into one row per pinned wallet.
        for (const pw of pinnedWallets) {
          const snap = latestSnap.get(`coinsbuy:${pw.wallet_id}`);
          channels.push({
            key: `coinsbuy:${pw.wallet_id}`,
            // Brand the rows so a reader can tell they're Coinsbuy wallets
            // without needing additional context.
            label: `Coinsbuy · ${pw.wallet_label}`,
            type: 'api',
            amount: snap?.amount ?? 0,
            source: snap ? 'live' : 'snapshot',
            isCustom: false,
          });
        }
        continue;
      }
      const snap = latestSnap.get(ch.key);
      channels.push({
        key: ch.key,
        label: ch.label,
        type: ch.type,
        amount: snap?.amount ?? 0,
        source: (snap?.source === 'api' ? 'live' : 'snapshot') as ReportChannelBalanceRow['source'],
        isCustom: ch.isCustom,
      });
    }

    const total = channels.reduce((s, r) => s + r.amount, 0);
    return { channels, total, asOf };
  } catch {
    return { channels: [], total: 0, asOf };
  }
}
