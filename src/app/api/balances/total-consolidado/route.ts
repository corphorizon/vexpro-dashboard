import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getBalanceWalletIds } from '@/lib/pinned-wallets';
import { fetchCoinsbuyWallets } from '@/lib/api-integrations/coinsbuy/wallets';
import { fetchUnipaymentBalances } from '@/lib/api-integrations/unipayment/balances';
import { apiError } from '@/lib/api-error';
import { resolveChannels, type ChannelConfigRow } from '@/lib/channel-configs';
import { pickChannelAmount, type ReportChannelSource } from '@/lib/reports/balances-by-channel';
import { isLiquid, normalizeLocationType, type LocationType } from '@/lib/cash-locations';

// ---------------------------------------------------------------------------
// GET /api/balances/total-consolidado
//
// Returns the same big number /balances shows at the bottom — Σ of every
// VISIBLE channel as it stands RIGHT NOW. Computed server-side so the home
// card doesn't have to repeat the logic and so we get fresh API values
// without waiting for the daily cron.
//
// LA LISTA DE CANALES SALE DE channel_configs, NO DE UNA LISTA FIJA.
// Hasta 2026-08 este endpoint sumaba siete claves hardcodeadas (coinsbuy,
// unipayment, fairpay, wallet_externa, otros + liquidez + inversiones), así
// que NINGUNA ubicación personalizada (`custom_*`) entraba jamás en el total:
// Vex Pro tenía una wallet propia con ~$16.335 de saldo de libro y el "Total
// Consolidado" de la home mostraba menos que /balances por exactamente esa
// plata. Ahora se resuelven los canales igual que en la pantalla
// (resolveChannels + is_visible) y se lee el mismo saldo.
//
// Resolution rules (mirror /balances `getChannelValue`):
//   · coinsbuy   → live API, sum of pinned wallets only
//   · unipayment → live API, sum of availableBalance
//   · resto      → LIBRO (channel_ledger_entries vía RPC), snapshot como
//                  respaldo para el canal que todavía no abrió libro
//   · liquidez   → running sum of liquidity_movements (deposit − withdrawal)
//   · inversiones → running sum of investments (deposit − withdrawal + profit)
//
// La elección libro-vs-snapshot NO se reimplementa acá: es `pickChannelAmount`
// de reports/balances-by-channel, la misma que usa el reporte. Tres copias de
// esa regla fue lo que hizo divergir las pantallas en la auditoría 2026-08.
//
// Each external API call has a 5s timeout. If one fails we fall back to its
// libro/snapshot so the total never silently drops to 0 because of a
// transient API blip. The response includes `breakdown` so the client can
// show "what counted" if it wants to.
//
// `total` incluye lo prestado, porque es lo que muestra /balances y los dos
// números tienen que coincidir. Para quien necesite la distinción, la
// respuesta trae además `liquid` (todo menos las ubicaciones `loan`) y `lent`
// — un préstamo es patrimonio, pero no es caja disponible mañana.
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

export async function GET(request: NextRequest) {
  try {
    // Sigue en verifyAuth (cualquier rol) A PROPÓSITO: la tarjeta de total
    // consolidado es la home de TODOS los usuarios, socios incluidos. Lo que
    // faltaba era el módulo — ahora sin 'balances' (para el usuario o para la
    // empresa) esto es 403 en vez de una cifra consolidada servida a cualquiera.
    const auth = await verifyAuth(request, { modules: ['balances'] });
    if (auth instanceof NextResponse) return auth;

    const admin = createAdminClient();
    const today = new Date().toISOString().slice(0, 10);

    // ── Parallel data pulls ──────────────────────────────────────────────
    const [
      configsRes,
      ledgerRes,
      asOfRes,
      pinnedRes,
      coinsbuyRes,
      unipaymentRes,
      liquidityRes,
      investmentsRes,
    ] = await Promise.allSettled([
      admin
        .from('channel_configs')
        .select(
          'id, channel_key, custom_label, channel_type, is_visible, is_custom, sort_order, location_type',
        )
        .eq('company_id', auth.companyId)
        .order('sort_order', { ascending: true }),
      admin.rpc('get_channel_ledger_balances', {
        p_company_id: auth.companyId,
        p_asof: today,
      }),
      admin.rpc('channel_balances_as_of', { p_company_id: auth.companyId, p_date: today }),
      // BALANCE → TODAS las wallets pineadas, operativas e internas: la plata
      // que está en la wallet de ahorro o en la de egresos sigue siendo plata
      // de la empresa (migración 084).
      getBalanceWalletIds(auth.companyId),
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

    // ── Canales de la empresa (built-ins + personalizados, solo visibles) ─
    const configRows: ChannelConfigRow[] =
      configsRes.status === 'fulfilled' && !configsRes.value.error
        ? ((configsRes.value.data ?? []) as ChannelConfigRow[])
        : [];
    const locationTypeByKey = new Map<string, LocationType>(
      configRows.map((r) => [r.channel_key, normalizeLocationType(r.location_type)]),
    );
    const visibleChannels = resolveChannels(configRows).filter((c) => c.isVisible);

    // ── Saldo del LIBRO por canal (fuente preferida) ─────────────────────
    const ledgerByKey = new Map<string, number>();
    if (ledgerRes.status === 'fulfilled' && !ledgerRes.value.error) {
      for (const r of (ledgerRes.value.data ?? []) as Array<{
        channel_key: string;
        balance: number | string;
      }>) {
        const n = Number(r.balance);
        if (Number.isFinite(n)) ledgerByKey.set(r.channel_key, n);
      }
    }

    // ── Channel snapshots (as-of today) — respaldo ───────────────────────
    type SnapRow = { channel_key: string; amount: number; source?: string };
    const snapshots: SnapRow[] =
      asOfRes.status === 'fulfilled' && !asOfRes.value.error
        ? (asOfRes.value.data ?? [])
        : [];
    const snapByKey = new Map(
      snapshots.map((s) => [
        s.channel_key,
        { amount: Number(s.amount || 0), source: s.source ?? 'manual' },
      ]),
    );

    // ── Coinsbuy: sum of pinned wallets from live API ────────────────────
    const pinnedIds: Set<string> = new Set(
      pinnedRes.status === 'fulfilled' ? pinnedRes.value : [],
    );

    type WalletLike = { id: string; balanceConfirmed?: number };
    let coinsbuyLive: number | null = null;
    if (
      coinsbuyRes.status === 'fulfilled' &&
      Array.isArray((coinsbuyRes.value as { wallets?: WalletLike[] }).wallets)
    ) {
      const wallets = (coinsbuyRes.value as { wallets: WalletLike[] }).wallets;
      // If user pinned some, sum only those. If they haven't pinned anything
      // we fall through to libro/snapshot (no ambiguous "all wallets" sum).
      if (pinnedIds.size > 0) {
        coinsbuyLive = wallets
          .filter((w) => pinnedIds.has(w.id))
          .reduce((s, w) => s + (w.balanceConfirmed ?? 0), 0);
      }
    }

    // ── UniPayment: live availableBalance sum ────────────────────────────
    type UniBal = { availableBalance?: number };
    let unipaymentLive: number | null = null;
    if (
      unipaymentRes.status === 'fulfilled' &&
      Array.isArray((unipaymentRes.value as { balances?: UniBal[] }).balances)
    ) {
      const balances = (unipaymentRes.value as { balances: UniBal[] }).balances;
      const sum = balances.reduce((s, b) => s + (b.availableBalance ?? 0), 0);
      if (sum > 0) unipaymentLive = sum;
    }

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

    // ── Un renglón por canal visible ─────────────────────────────────────
    const breakdown: Record<
      string,
      { amount: number; source: ReportChannelSource; label: string; liquid: boolean }
    > = {};
    let total = 0;
    let liquid = 0;
    let lent = 0;

    for (const ch of visibleChannels) {
      let amount: number;
      let source: ReportChannelSource;

      if (ch.key === 'liquidez') {
        amount = liquidez;
        source = 'computed';
      } else if (ch.key === 'inversiones') {
        amount = inversiones;
        source = 'computed';
      } else if (ch.key === 'coinsbuy' && coinsbuyLive !== null) {
        amount = coinsbuyLive;
        source = 'live';
      } else if (ch.key === 'unipayment' && unipaymentLive !== null) {
        amount = unipaymentLive;
        source = 'live';
      } else {
        const picked = pickChannelAmount({
          channelKey: ch.key,
          ledgerBalance: ledgerByKey.get(ch.key),
          snapshot: snapByKey.get(ch.key),
        });
        amount = picked.amount;
        source = picked.source;
      }

      // liquidez/inversiones no son ubicaciones físicas: no tienen fila en
      // channel_configs con tipo, y ninguna de las dos es un préstamo.
      const isLent = !isLiquid(locationTypeByKey.get(ch.key));
      total += amount;
      if (isLent) lent += amount;
      else liquid += amount;

      breakdown[ch.key] = { amount, source, label: ch.label, liquid: !isLent };
    }

    return NextResponse.json({
      success: true,
      total,
      liquid,
      lent,
      asOf: new Date().toISOString(),
      breakdown,
    });
  } catch (err) {
    return apiError('balances/total-consolidado', err, { status: 500 });
  }
}
