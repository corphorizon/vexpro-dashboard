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
    const fromDate = new Date(asOf);
    fromDate.setUTCDate(fromDate.getUTCDate() - 30);
    const fromIso = fromDate.toISOString().slice(0, 10);

    const { data: snapRows } = await admin
      .from('channel_balances')
      .select('channel_key, snapshot_date, amount, source')
      .eq('company_id', companyId)
      .in('channel_key', visibleKeys)
      .lte('snapshot_date', asOf)
      .gte('snapshot_date', fromIso)
      .order('snapshot_date', { ascending: false });

    const latestSnap = new Map<string, { amount: number; source: string }>();
    for (const r of snapRows ?? []) {
      if (!latestSnap.has(r.channel_key)) {
        latestSnap.set(r.channel_key, { amount: Number(r.amount) || 0, source: r.source });
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

    // 4. Build the output rows.
    const channels: ReportChannelBalanceRow[] = visible.map((ch) => {
      if (ch.key === 'liquidez') {
        return {
          key: ch.key,
          label: ch.label,
          type: ch.type,
          amount: liquidezTotal,
          source: 'computed',
          isCustom: ch.isCustom,
        };
      }
      if (ch.key === 'inversiones') {
        return {
          key: ch.key,
          label: ch.label,
          type: ch.type,
          amount: investmentsTotal,
          source: 'computed',
          isCustom: ch.isCustom,
        };
      }
      const snap = latestSnap.get(ch.key);
      return {
        key: ch.key,
        label: ch.label,
        type: ch.type,
        amount: snap?.amount ?? 0,
        source: (snap?.source === 'api' ? 'live' : 'snapshot') as ReportChannelBalanceRow['source'],
        isCustom: ch.isCustom,
      };
    });

    const total = channels.reduce((s, r) => s + r.amount, 0);
    return { channels, total, asOf };
  } catch {
    return { channels: [], total: 0, asOf };
  }
}
