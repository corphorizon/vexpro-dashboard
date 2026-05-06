import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ProviderDataset, ProviderSlug } from '@/lib/api-integrations/types';

// ---------------------------------------------------------------------------
// GET /api/integrations/persisted-movements
//
// Returns the LAST PERSISTED state of the four provider datasets — the
// Movimientos page uses this on initial load AND the breakdown page
// (/movimientos/desglose/[slug]) uses it on every load. Everything here
// comes from Supabase (api_transactions + api_sync_log), nothing hits
// external APIs.
//
// Query params (all optional):
//   from=YYYY-MM-DD     inclusive lower bound on transaction_date
//   to=YYYY-MM-DD       inclusive upper bound on transaction_date
//   walletId=<id>       when set, also filter Coinsbuy rows by wallet_id
//                       (special value 'all' or empty disables the filter)
//   slug=<provider>     return only this provider's dataset under
//                       `dataset` (single object) instead of `datasets`
//                       (4-array). Used by the breakdown page so it can
//                       read from DB instead of hitting the live API.
//                       Valid: coinsbuy-deposits | coinsbuy-withdrawals |
//                              fairpay | unipayment
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
    const walletIdRaw = request.nextUrl.searchParams.get('walletId');
    // Treat empty string and the literal 'all' as "no filter" so the
    // wallet selector in /movimientos can offer a "Todas las wallets"
    // option without leaving the URL param dangling.
    const walletId =
      walletIdRaw && walletIdRaw !== 'all' && walletIdRaw.length > 0
        ? walletIdRaw
        : null;
    const slugParam = request.nextUrl.searchParams.get('slug');
    const requestedSlug =
      slugParam && (SLUGS as string[]).includes(slugParam)
        ? (slugParam as ProviderSlug)
        : null;

    const admin = createAdminClient();

    // ── Mapa de exclusiones manuales (provider:external_id → metadata) ───
    // Solo aplica a coinsbuy-deposits hoy. Se usa para enriquecer las
    // transactions con `excluded`, `excludedReason`, `excludedByName`,
    // `excludedAt`. La UI las oculta por defecto y `computeProviderTotals`
    // las descuenta del total.
    const { data: excludedRows } = await admin
      .from('excluded_transactions')
      .select('external_id, reason, excluded_by_name, excluded_at, provider')
      .eq('company_id', auth.companyId);
    const excludedMap = new Map<
      string,
      { reason: string; excludedByName: string | null; excludedAt: string }
    >();
    for (const r of excludedRows ?? []) {
      excludedMap.set(`${r.provider}:${r.external_id}`, {
        reason: r.reason,
        excludedByName: r.excluded_by_name,
        excludedAt: r.excluded_at,
      });
    }

    // ── Why per-slug queries? ─────────────────────────────────────────────
    // Supabase / PostgREST caps responses at `db_max_rows` (default 1000)
    // even when `.limit()` requests more. A single April for an active
    // tenant has ~1800 rows across the 4 providers; the old "one query for
    // all providers" approach hit the cap and silently returned the most
    // recent 1000, distributed proportionally across slugs. That's exactly
    // what produced the banner ≠ desglose discrepancy Kevin reported on
    // 2026-05-02 (368 vs 559 for coinsbuy-deposits, etc).
    //
    // Splitting into 4 parallel per-slug queries keeps each well under
    // the 1000-row cap (largest slug = unipayment ~600). The per-row
    // filter logic stays identical via `runOne` below.
    const runOne = async (slug: ProviderSlug) => {
      let q = admin
        .from('api_transactions')
        .select(
          'provider, external_id, amount, fee, currency, status, transaction_date, wallet_id, wallet_label, raw',
        )
        .eq('company_id', auth.companyId)
        .eq('provider', slug)
        .order('transaction_date', { ascending: false })
        .limit(10000);
      if (from) q = q.gte('transaction_date', `${from}T00:00:00.000Z`);
      if (to) q = q.lte('transaction_date', `${to}T23:59:59.999Z`);
      const { data, error } = await q;
      if (error) {
        console.error(
          `[persisted-movements] ${slug} query failed:`,
          error.message,
        );
        return [] as NonNullable<typeof data>;
      }
      return data ?? [];
    };

    const slugsToFetch: ProviderSlug[] = requestedSlug ? [requestedSlug] : [...SLUGS];
    const perSlugRows = await Promise.all(slugsToFetch.map(runOne));

    // Flatten — `buildDataset` filters to its own slug below.
    const rows = perSlugRows.flat();

    // Last sync timestamp — when slug is requested, scope to that provider so
    // the breakdown page can show "datos del último sync hace Xh" precisely.
    let lastSyncQ = admin
      .from('api_sync_log')
      .select('last_synced_at, provider')
      .eq('company_id', auth.companyId)
      .order('last_synced_at', { ascending: false })
      .limit(1);
    if (requestedSlug) lastSyncQ = lastSyncQ.eq('provider', requestedSlug);
    const { data: lastSyncRow } = await lastSyncQ.maybeSingle();

    const buildDataset = (slug: ProviderSlug): ProviderDataset => {
      const matches = (rows ?? []).filter((r) => {
        if (r.provider !== slug) return false;
        // Wallet filter only meaningful for Coinsbuy rows. Rows persisted
        // BEFORE migration 041 have wallet_id=NULL — keep them in until
        // re-sync populates the column, otherwise Vex Pro's historic
        // breakdown would suddenly empty out.
        if (
          walletId &&
          slug.startsWith('coinsbuy') &&
          r.wallet_id &&
          r.wallet_id !== walletId
        ) {
          return false;
        }
        return true;
      });

      // Rehydrate the original transaction shape from the `raw` column that
      // was stored at persist time. If raw is missing, synthesise a minimal
      // row so the table can still render.
      const transactions = matches.map((r) => {
        const raw = r.raw as Record<string, unknown> | null;
        const base = raw && typeof raw === 'object' ? { ...raw } : {
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
        // Always overlay the persisted wallet_id / wallet_label so older
        // raw payloads (from before the 2026-05-01 fetcher upgrade) get
        // the new fields too once a re-sync runs.
        if (r.wallet_id) (base as Record<string, unknown>).walletId = r.wallet_id;
        if (r.wallet_label) (base as Record<string, unknown>).walletLabel = r.wallet_label;
        // Enriquecer con info de exclusión manual (solo coinsbuy-deposits hoy).
        const excludedInfo = excludedMap.get(`${slug}:${r.external_id}`);
        if (excludedInfo) {
          (base as Record<string, unknown>).excluded = true;
          (base as Record<string, unknown>).excludedReason = excludedInfo.reason;
          (base as Record<string, unknown>).excludedByName = excludedInfo.excludedByName;
          (base as Record<string, unknown>).excludedAt = excludedInfo.excludedAt;
        }
        return base;
      });

      return {
        slug,
        provider: PROVIDER_ID[slug],
        kind: PROVIDER_KIND[slug],
        transactions: transactions as unknown as ProviderDataset['transactions'],
        fetchedAt: lastSyncRow?.last_synced_at ?? new Date(0).toISOString(),
        status: 'fresh' as const,
        isMock: false,
      };
    };

    if (requestedSlug) {
      return NextResponse.json({
        success: true,
        dataset: buildDataset(requestedSlug),
        fetchedAt: lastSyncRow?.last_synced_at ?? null,
      });
    }

    const datasets = SLUGS.map((slug) => buildDataset(slug));

    return NextResponse.json({
      success: true,
      datasets,
      fetchedAt: lastSyncRow?.last_synced_at ?? null,
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
