import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCoinsbuyWallets } from '@/lib/api-integrations/coinsbuy/wallets';
import { fetchUnipaymentBalances } from '@/lib/api-integrations/unipayment/balances';

// ---------------------------------------------------------------------------
// GET /api/balances/total-consolidado
//
// Returns the same big number /balances shows at the bottom — Σ of every
// channel as it stands RIGHT NOW. Computed server-side so the home card
// doesn't have to repeat the logic and so we get fresh API values without
// waiting for the daily cron.
//
// Resolution rules (mirror /balances `getChannelValue`):
//   · coinsbuy   → live API, sum of pinned wallets only
//   · unipayment → live API, sum of availableBalance
//   · fairpay / wallet_externa / otros → channel_balances_as_of(today)
//   · liquidez   → running sum of liquidity_movements (deposit − withdrawal)
//   · inversiones → running sum of investments (deposit − withdrawal + profit)
//
// Each external API call has a 5s timeout. If one fails we fall back to its
// most recent snapshot from channel_balances so the total never silently
// drops to 0 because of a transient API blip. The response includes
// `breakdown` so the client can show "what counted" if it wants to.
// ---------------------------------------------------------------------------

const API_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms),
    ),
  ]);
}

export async function GET() {
  try {
    const auth = await verifyAuth();
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const today = new Date().toISOString().slice(0, 10);

    // ── Parallel data pulls ──────────────────────────────────────────────
    const [
      asOfRes,
      pinnedRes,
      coinsbuyRes,
      unipaymentRes,
      liquidityRes,
      investmentsRes,
    ] = await Promise.allSettled([
      admin.rpc('channel_balances_as_of', { p_company_id: auth.companyId, p_date: today }),
      admin
        .from('pinned_coinsbuy_wallets')
        .select('wallet_id')
        .eq('company_id', auth.companyId),
      withTimeout(fetchCoinsbuyWallets(auth.companyId), API_TIMEOUT_MS),
      withTimeout(fetchUnipaymentBalances(auth.companyId), API_TIMEOUT_MS),
      admin
        .from('liquidity_movements')
        .select('deposit, withdrawal')
        .eq('company_id', auth.companyId),
      admin
        .from('investments')
        .select('deposit, withdrawal, profit')
        .eq('company_id', auth.companyId),
    ]);

    // ── Channel snapshots (as-of today) ──────────────────────────────────
    type SnapRow = { channel_key: string; amount: number; source?: string };
    const snapshots: SnapRow[] =
      asOfRes.status === 'fulfilled' && !asOfRes.value.error
        ? (asOfRes.value.data ?? [])
        : [];
    const snapByKey = new Map(snapshots.map((s) => [s.channel_key, Number(s.amount || 0)]));

    // ── Coinsbuy: sum of pinned wallets from live API ────────────────────
    type Pinned = { wallet_id: string };
    const pinnedIds: Set<string> = new Set(
      pinnedRes.status === 'fulfilled' && !pinnedRes.value.error
        ? ((pinnedRes.value.data as Pinned[] | null) ?? []).map((p) => p.wallet_id)
        : [],
    );

    type WalletLike = { id: string; balanceConfirmed?: number };
    let coinsbuyTotal = 0;
    let coinsbuySource: 'live' | 'snapshot' | 'none' = 'none';
    if (
      coinsbuyRes.status === 'fulfilled' &&
      Array.isArray((coinsbuyRes.value as { wallets?: WalletLike[] }).wallets)
    ) {
      const wallets = (coinsbuyRes.value as { wallets: WalletLike[] }).wallets;
      // If user pinned some, sum only those. If they haven't pinned anything
      // we fall through to snapshot (no ambiguous "all wallets" sum).
      if (pinnedIds.size > 0) {
        coinsbuyTotal = wallets
          .filter((w) => pinnedIds.has(w.id))
          .reduce((s, w) => s + (w.balanceConfirmed ?? 0), 0);
        coinsbuySource = 'live';
      }
    }
    if (coinsbuySource === 'none' && snapByKey.has('coinsbuy')) {
      coinsbuyTotal = snapByKey.get('coinsbuy')!;
      coinsbuySource = 'snapshot';
    }

    // ── UniPayment: live availableBalance sum ────────────────────────────
    type UniBal = { availableBalance?: number };
    let unipaymentTotal = 0;
    let unipaymentSource: 'live' | 'snapshot' | 'none' = 'none';
    if (
      unipaymentRes.status === 'fulfilled' &&
      Array.isArray((unipaymentRes.value as { balances?: UniBal[] }).balances)
    ) {
      const balances = (unipaymentRes.value as { balances: UniBal[] }).balances;
      unipaymentTotal = balances.reduce((s, b) => s + (b.availableBalance ?? 0), 0);
      if (unipaymentTotal > 0) unipaymentSource = 'live';
    }
    if (unipaymentSource === 'none' && snapByKey.has('unipayment')) {
      unipaymentTotal = snapByKey.get('unipayment')!;
      unipaymentSource = 'snapshot';
    }

    // ── Manual-only channels (carry-forward via as-of) ───────────────────
    const fairpay = snapByKey.get('fairpay') ?? 0;
    const walletExterna = snapByKey.get('wallet_externa') ?? 0;
    const otros = snapByKey.get('otros') ?? 0;

    // ── Liquidez running balance ─────────────────────────────────────────
    type LiqRow = { deposit: number | null; withdrawal: number | null };
    const liquidez =
      liquidityRes.status === 'fulfilled' && !liquidityRes.value.error
        ? ((liquidityRes.value.data as LiqRow[] | null) ?? []).reduce(
            (s, r) => s + (r.deposit ?? 0) - (r.withdrawal ?? 0),
            0,
          )
        : 0;

    // ── Inversiones running balance ──────────────────────────────────────
    type InvRow = { deposit: number | null; withdrawal: number | null; profit: number | null };
    const inversiones =
      investmentsRes.status === 'fulfilled' && !investmentsRes.value.error
        ? ((investmentsRes.value.data as InvRow[] | null) ?? []).reduce(
            (s, r) => s + (r.deposit ?? 0) - (r.withdrawal ?? 0) + (r.profit ?? 0),
            0,
          )
        : 0;

    const total =
      coinsbuyTotal +
      unipaymentTotal +
      fairpay +
      walletExterna +
      otros +
      liquidez +
      inversiones;

    return NextResponse.json({
      success: true,
      total,
      asOf: new Date().toISOString(),
      breakdown: {
        coinsbuy: { amount: coinsbuyTotal, source: coinsbuySource },
        unipayment: { amount: unipaymentTotal, source: unipaymentSource },
        fairpay: { amount: fairpay, source: snapByKey.has('fairpay') ? 'snapshot' : 'none' },
        wallet_externa: { amount: walletExterna, source: snapByKey.has('wallet_externa') ? 'snapshot' : 'none' },
        otros: { amount: otros, source: snapByKey.has('otros') ? 'snapshot' : 'none' },
        liquidez: { amount: liquidez, source: 'live' },
        inversiones: { amount: inversiones, source: 'live' },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
