import { NextRequest, NextResponse } from 'next/server';
import { friendlyDbMessage } from '@/lib/errors';
import { verifyAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { getOperatingWalletScope } from '@/lib/pinned-wallets';
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
//                       (one entry per slug). Used by the breakdown page so
//                       it can read from DB instead of hitting the live API.
//                       Valid: coinsbuy-deposits | coinsbuy-withdrawals |
//                              fairpay | unipayment | paypros
// ---------------------------------------------------------------------------

const SLUGS: ProviderSlug[] = [
  'coinsbuy-deposits',
  'coinsbuy-withdrawals',
  'fairpay',
  'unipayment',
  // Pay-Pros no se sincroniza desde acá (no hay endpoint de listado), pero sus
  // filas SÍ viven en api_transactions desde el 2026-07-22. Sin este slug la
  // tarjeta «Depósitos» de /movimientos leía tres canales y dejaba afuera
  // $44.653,95 que el backend (loadPersistedTotals) sí contaba.
  'paypros',
];

const PROVIDER_KIND: Record<ProviderSlug, 'deposits' | 'withdrawals'> = {
  'coinsbuy-deposits': 'deposits',
  'coinsbuy-withdrawals': 'withdrawals',
  fairpay: 'deposits',
  unipayment: 'deposits',
  // Pay-Pros trae los dos sentidos en el mismo provider; el dataset se
  // etiqueta 'deposits' porque es lo que totaliza (status 'paid').
  paypros: 'deposits',
};

const PROVIDER_ID: Record<ProviderSlug, 'coinsbuy' | 'fairpay' | 'unipayment' | 'paypros'> = {
  'coinsbuy-deposits': 'coinsbuy',
  'coinsbuy-withdrawals': 'coinsbuy',
  fairpay: 'fairpay',
  unipayment: 'unipayment',
  paypros: 'paypros',
};

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAuth(request, { modules: ['movements', 'partners'] });
    if (auth instanceof NextResponse) return auth;

    const from = request.nextUrl.searchParams.get('from');
    const to = request.nextUrl.searchParams.get('to');
    const walletIdRaw = request.nextUrl.searchParams.get('walletId');
    // BUG-05 (reescrito 2026-08-17) — scope de wallets de Coinsbuy. Tres modos:
    //   · 'single'  → walletId explícito (deep-link del desglose a UNA wallet)
    //   · 'all'     → literal 'all' (el desglose ofrece "Todas las wallets")
    //   · 'pinned'  → vacío/ausente (DEFAULT, usado por /movimientos para los
    //                 totales): scopea a las wallets pineadas OPERATIVAS.
    //
    // Por qué ya NO es "todas las pineadas": la versión anterior de este
    // comentario decía "IGUAL que /balances" y unificaba a propósito los dos
    // criterios. Eso era correcto solo mientras la única wallet pineada de
    // Vex Pro era 1079 "Main". Cuando se pinnearon 1087 "Savings Vex Pro" y
    // 1705 "Egresos Vex" —que son tesorería interna y se pinnearon para que
    // sumaran al BALANCE— esta pantalla se las llevó puestas: Retiros Totales
    // $932.444,83 en vez de los $469.650,98 de la operativa, y Net Deposit
    // −$231.127 alimentando la cadena de distribución.
    // Balance y movimientos son dos preguntas distintas: la primera la
    // responde getBalanceWalletIds, esta la responde getOperatingWalletIds.
    const walletMode: 'single' | 'all' | 'pinned' =
      walletIdRaw === 'all'
        ? 'all'
        : walletIdRaw && walletIdRaw.length > 0
          ? 'single'
          : 'pinned';
    const walletId = walletMode === 'single' ? walletIdRaw : null;
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

    // Set de wallets OPERATIVAS (para walletMode='pinned'). Company-wide.
    // Si la empresa no tiene NINGUNA wallet pineada no se filtra (= todas,
    // igual que el `p.ids IS NULL` del RPC). Si tiene pineadas pero todas
    // internas, `scoped` queda en true con la lista vacía y no cuenta ninguna
    // tx de Coinsbuy: es lo que el admin configuró.
    let pinnedIds: string[] = [];
    let walletScoped = false;
    if (walletMode === 'pinned') {
      const scope = await getOperatingWalletScope(auth.companyId);
      pinnedIds = scope.ids;
      walletScoped = scope.scoped;
    }
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
      // PostgREST tiene un cap silencioso de db_max_rows (default 1000) que
      // ignora el .limit() que se pase. Para tenants con volumen alto
      // (coinsbuy-deposits tiene 2078 filas para VexPro a junio 2026), una
      // sola query devolvía solo los 1000 más nuevos y la UI mostraba "desde
      // 6 mayo" en vez de todo el histórico. La fix es paginar con .range()
      // en bloques de 1000 hasta agotar el dataset. Cap de seguridad en 20
      // páginas (= 20k filas por slug por query) para evitar loops infinitos
      // en escenarios patológicos.
      const PAGE_SIZE = 1000;
      const MAX_PAGES = 20;
      // Capturar companyId acá: dentro de la función anidada fetchPage TS
      // pierde el narrowing de `auth` (instanceof NextResponse) hecho arriba.
      const companyId = auth.companyId;
      let accumulated: Awaited<ReturnType<typeof fetchPage>> = [];
      let page = 0;
      let lastPageSize = PAGE_SIZE;

      async function fetchPage(p: number) {
        let q = admin
          .from('api_transactions')
          .select(
            'provider, external_id, amount, fee, currency, status, transaction_date, wallet_id, wallet_label, internal, raw',
          )
          .eq('company_id', companyId)
          .eq('provider', slug)
          .order('transaction_date', { ascending: false })
          .range(p * PAGE_SIZE, (p + 1) * PAGE_SIZE - 1);
        if (from) q = q.gte('transaction_date', `${from}T00:00:00.000Z`);
        if (to) q = q.lte('transaction_date', `${to}T23:59:59.999Z`);
        const { data, error } = await q;
        if (error) {
          console.error(
            `[persisted-movements] ${slug} page ${p} query failed:`,
            error.message,
          );
          return [] as NonNullable<typeof data>;
        }
        return data ?? [];
      }

      while (lastPageSize === PAGE_SIZE && page < MAX_PAGES) {
        const rows = await fetchPage(page);
        accumulated = accumulated.concat(rows);
        lastPageSize = rows.length;
        page++;
      }

      if (page === MAX_PAGES && lastPageSize === PAGE_SIZE) {
        console.warn(
          `[persisted-movements] ${slug}: hit MAX_PAGES=${MAX_PAGES} cap, posible truncamiento. ` +
            `Filas leídas: ${accumulated.length}. Revisar volumen del slug.`,
        );
      }

      return accumulated;
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
        if (slug.startsWith('coinsbuy') && r.wallet_id) {
          if (walletMode === 'single' && r.wallet_id !== walletId) return false;
          if (
            walletMode === 'pinned' &&
            walletScoped &&
            !pinnedIds.includes(r.wallet_id)
          ) {
            return false;
          }
          // walletMode === 'all' → sin filtro de wallet
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
        // Pay-Pros: el `raw` guardado NO es la transacción, es la PROCEDENCIA
        // ({source, depositId, externalPaymentId, userId, crmStatus} cuando
        // viene del espejo del CRM). Si nos quedáramos con él, la fila llegaría
        // sin id, sin fecha, sin monto y sin status → `computeProviderTotals`
        // no la contaría y la tarjeta seguiría en cero, sin ningún error a la
        // vista. Las columnas son la fuente de verdad para este proveedor.
        if (slug === 'paypros') {
          const b = base as Record<string, unknown>;
          b.id = r.external_id;
          b.provider = 'paypros';
          b.createdAt = r.transaction_date;
          b.amount = Number(r.amount) || 0;
          b.currency = r.currency ?? 'USD';
          b.status = r.status ?? '';
          b.kind = r.status === 'payout_paid' ? 'withdrawal' : 'deposit';
          b.notifyReference =
            (raw?.notifyReference as string | undefined) ??
            (raw?.externalPaymentId as string | undefined) ??
            '';
        }
        // Always overlay the persisted wallet_id / wallet_label so older
        // raw payloads (from before the 2026-05-01 fetcher upgrade) get
        // the new fields too once a re-sync runs.
        if (r.wallet_id) (base as Record<string, unknown>).walletId = r.wallet_id;
        if (r.wallet_label) (base as Record<string, unknown>).walletLabel = r.wallet_label;
        // Overlay de `internal` desde la COLUMNA (igual que wallet_id): las
        // filas persistidas antes del fix no traen el campo dentro de `raw`,
        // pero después del backfill la columna es la fuente de verdad. Así
        // computeProviderTotals y la UI ven la marca sin re-sync del raw.
        if (r.internal === true) (base as Record<string, unknown>).internal = true;
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
      { success: false, error: friendlyDbMessage(err), datasets: [], fetchedAt: null },
      { status: 500 },
    );
  }
}
