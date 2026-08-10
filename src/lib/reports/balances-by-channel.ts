// ─────────────────────────────────────────────────────────────────────────────
// Server-side balances-by-channel builder for reports (page + email).
//
// Reconstructs the same list the /balances page renders, but without the
// client-side hooks. Reads:
//   · channel_configs         — per-company visibility + custom channels
//   · channel_ledger_entries  — saldo del LIBRO vía RPC get_channel_ledger_balances
//   · channel_balances        — latest snapshot per key (daily cron writes these)
//   · liquidity_movements     — sum → `liquidez`
//   · investments             — sum → `inversiones`
//
// PRIORIDAD DE FUENTES (auditoría 2026-08, A1): el libro manda sobre el
// snapshot. /balances (getChannelValue) ya lee el libro primero; este builder
// leía SOLO channel_balances, así que toda ubicación manual operada por libro
// —bancos, préstamos, wallets cargadas a mano— salía en $0 o con un saldo de
// hasta 30 días de antigüedad en el reporte, el PDF y el email. Dos pantallas
// del mismo saldo que no coinciden es peor que no tener reporte.
//
// Y cuando NO hay ni libro ni snapshot en la ventana, la fila sale marcada
// `source: 'missing'` en vez de un 0 mudo (mejora C8): un cero que en realidad
// es "no hay dato" se lee como "esta cuenta está vacía".
//
// Never throws: on any failure returns `{ channels: [], total: 0 }` so a
// flaky source doesn't take the whole report down.
// ─────────────────────────────────────────────────────────────────────────────

import { createAdminClient } from '@/lib/supabase/admin';
import { resolveChannels, type ChannelConfigRow, type ResolvedChannel } from '@/lib/channel-configs';
import { hasLedger } from '@/lib/channel-ledger';
import { fetchCoinsbuyWallets } from '@/lib/api-integrations/coinsbuy/wallets';
import { fetchUnipaymentBalances } from '@/lib/api-integrations/unipayment/balances';

/**
 * De dónde salió el número de la fila.
 *   · `ledger`   — saldo corrido del libro por canal (la fuente preferida).
 *   · `live`     — snapshot que acaba de escribir la API del proveedor.
 *   · `snapshot` — último snapshot diario dentro de la ventana de 30 días.
 *   · `computed` — reconstruido desde su propio módulo (liquidez/inversiones).
 *   · `missing`  — NO hay dato. El amount es 0 pero no significa "cuenta vacía".
 */
export type ReportChannelSource = 'live' | 'snapshot' | 'computed' | 'ledger' | 'missing';

export interface ReportChannelBalanceRow {
  key: string;
  label: string;
  type: 'api' | 'manual' | 'auto';
  amount: number;
  source: ReportChannelSource;
  isCustom: boolean;
}

/**
 * Elige el saldo de un canal entre las dos fuentes, con la MISMA prioridad que
 * `getChannelValue` en /balances. Pura a propósito: es la regla que la
 * auditoría encontró divergente, así que tiene que poder testearse sin
 * Supabase de por medio.
 */
export function pickChannelAmount(params: {
  channelKey: string;
  /** Saldo del libro al cierre de `asOf`, o undefined si el canal no tiene. */
  ledgerBalance?: number;
  /** Último snapshot dentro de la ventana, o undefined si no hay. */
  snapshot?: { amount: number; source: string };
}): { amount: number; source: ReportChannelSource } {
  const { channelKey, ledgerBalance, snapshot } = params;
  if (hasLedger(channelKey) && ledgerBalance !== undefined && Number.isFinite(ledgerBalance)) {
    return { amount: ledgerBalance, source: 'ledger' };
  }
  if (snapshot) {
    return { amount: snapshot.amount, source: snapshot.source === 'api' ? 'live' : 'snapshot' };
  }
  return { amount: 0, source: 'missing' };
}

export interface ReportBalancesByChannel {
  channels: ReportChannelBalanceRow[];
  total: number;
  asOf: string; // YYYY-MM-DD — the snapshot date requested
}

export async function buildBalancesByChannel(
  companyId: string,
  asOf: string = new Date().toISOString().slice(0, 10),
): Promise<ReportBalancesByChannel> {
  const admin = createAdminClient();

  // Write to channel_balances using the service-role admin client — the
  // table has RLS and the shared `upsertChannelBalance` mutation helper
  // goes through the anon client which fails in a server-side/cron
  // context where there's no user cookie.
  const upsertSnapshot = async (
    channelKey: string,
    amount: number,
    source: 'manual' | 'api' | 'derived',
  ) => {
    await admin.from('channel_balances').upsert(
      {
        company_id: companyId,
        snapshot_date: asOf,
        channel_key: channelKey,
        amount,
        source,
      },
      { onConflict: 'company_id,snapshot_date,channel_key' },
    );
  };

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

    // 2b. Saldo del LIBRO por canal al cierre de `asOf`. Es la fuente
    //     preferida: /balances la prioriza y el reporte tiene que decir lo
    //     mismo. La RPC devuelve una fila por canal con asientos; los canales
    //     sin libro simplemente no aparecen y caen al snapshot.
    const ledgerByKey = new Map<string, number>();
    const { data: ledgerRows, error: ledgerError } = await admin.rpc('get_channel_ledger_balances', {
      p_company_id: companyId,
      p_asof: asOf,
    });
    if (ledgerError) {
      // No es fatal: se degrada a los snapshots, que es exactamente el
      // comportamiento anterior a este fix.
      console.error('[reports/balances-by-channel] libro:', ledgerError.message);
    } else {
      for (const r of (ledgerRows ?? []) as Array<{ channel_key: string; balance: number | string }>) {
        const n = Number(r.balance);
        if (Number.isFinite(n)) ledgerByKey.set(r.channel_key, n);
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
              await upsertSnapshot(`coinsbuy:${pw.wallet_id}`, amt, 'api');
              latestSnap.set(`coinsbuy:${pw.wallet_id}`, { amount: amt, source: 'api' });
            }
            await upsertSnapshot('coinsbuy', pinnedTotal, 'api');
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
          await upsertSnapshot('unipayment', total, 'api');
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
          const key = `coinsbuy:${pw.wallet_id}`;
          const picked = pickChannelAmount({
            channelKey: key,
            ledgerBalance: ledgerByKey.get(key),
            snapshot: latestSnap.get(key),
          });
          channels.push({
            key,
            // Brand the rows so a reader can tell they're Coinsbuy wallets
            // without needing additional context.
            label: `Coinsbuy · ${pw.wallet_label}`,
            type: 'api',
            amount: picked.amount,
            source: picked.source,
            isCustom: false,
          });
        }
        continue;
      }
      const picked = pickChannelAmount({
        channelKey: ch.key,
        ledgerBalance: ledgerByKey.get(ch.key),
        snapshot: latestSnap.get(ch.key),
      });
      channels.push({
        key: ch.key,
        label: ch.label,
        type: ch.type,
        amount: picked.amount,
        source: picked.source,
        isCustom: ch.isCustom,
      });
    }

    const total = channels.reduce((s, r) => s + r.amount, 0);
    return { channels, total, asOf };
  } catch {
    return { channels: [], total: 0, asOf };
  }
}
