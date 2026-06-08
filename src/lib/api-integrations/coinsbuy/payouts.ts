// ─────────────────────────────────────────────────────────────────────────────
// Coinsbuy v3 — Payouts (withdrawals) service
//
// Fetches ALL transfers from GET /transfer/ (no server-side filters since the
// Coinsbuy v3 API may reject unknown filter params). Then filters client-side:
//   • op_type === 2  → payout
//   • status  === 2  → confirmed/approved
//   • amount > 0
//   • optionally by wallet id
//
// charged_amount = amount + commission (what was actually deducted).
// When credentials are not configured, falls back to mock data.
// ─────────────────────────────────────────────────────────────────────────────

import { getCoinsbuyToken, isCoinsbuyV3Enabled, getCoinsbuyBaseUrl } from './auth';
import { proxiedFetch } from '../proxy';
import { withRetry } from '../retry';
import type { CoinsbuyWithdrawalTx, ProviderDataset } from '../types';
import { generateCoinsbuyWithdrawals } from '../mocks';
import { filterByDateRange } from '../totals';
import { createAdminClient } from '@/lib/supabase/admin';

// Per-tenant base URL is resolved at call time via getCoinsbuyBaseUrl().

const PAGE_SIZE = 100;
// Antes era 20 (= cap de 2000 transfers). VexPro a junio 2026 ya tiene >2000
// transfers totales, lo que cortaba el sync en transfers viejos. Subiendo a
// 200 (= cap de 20k transfers) damos margen amplio para el crecimiento; el
// sync incremental (ver INCREMENTAL_SYNC_OVERLAP_HOURS) hace que normalmente
// no se pagine ni 5 páginas por sync.
const MAX_PAGES = 200;

// Ventana de overlap para sync incremental: el cron sincroniza N veces al día,
// y para no perder transacciones que CoinsBuy procesó "tarde" o que están en
// estado pending durante el sync anterior, el sync trae 24h hacia atrás del
// timestamp del último sync persistido. El caller puede pasar `since`
// explícito; si no, el helper recupera el último sync de api_sync_log y
// resta 24h. Si nunca se sincronizó (primera vez), trae TODO el histórico
// sin ventana (paginando hasta agotar).
const INCREMENTAL_SYNC_OVERLAP_HOURS = 24;

// ── JSON:API response shapes ────────────────────────────────────────────────

interface TransferAttributes {
  op_id: number;
  op_type: number;
  amount: string;
  amount_target: string;
  commission: string;
  fee: string;
  txid: string;
  status: number;
  created_at: string;
  updated_at: string;
}

interface TransferResource {
  id: string;
  type: string;
  attributes: TransferAttributes;
  relationships?: {
    currency?: { data: { type: string; id: string } };
    wallet?: { data: { type: string; id: string } };
    parent?: { data: { type: string; id: string } };
  };
}

interface TransferListResponse {
  data: TransferResource[];
  meta: {
    pagination: {
      page: number;
      pages: number;
      count: number;
    };
  };
}

// ── Main fetch ──────────────────────────────────────────────────────────────

export async function fetchCoinsbuyPayoutsV3(
  options: { from?: string; to?: string; walletId?: string; companyId?: string | null } = {},
): Promise<ProviderDataset<CoinsbuyWithdrawalTx>> {
  const now = new Date().toISOString();
  const { companyId } = options;

  // Mock fallback
  if (!(await isCoinsbuyV3Enabled(companyId))) {
    const all = generateCoinsbuyWithdrawals();
    return {
      slug: 'coinsbuy-withdrawals',
      provider: 'coinsbuy',
      kind: 'withdrawals',
      transactions: filterByDateRange(all, options.from, options.to),
      fetchedAt: now,
      status: 'fresh',
      isMock: true,
    };
  }

  // Live mode: fetch ALL transfers, filter client-side
  try {
    const token = await getCoinsbuyToken(companyId);
    const baseUrl = await getCoinsbuyBaseUrl(companyId);
    const allTransactions: CoinsbuyWithdrawalTx[] = [];

    // Resolver ventana de sync incremental. Si el caller pasó `options.from`
    // explícito, usar ese. Si no, leer último sync de api_sync_log y restar
    // INCREMENTAL_SYNC_OVERLAP_HOURS. Si nunca se sincronizó, trae todo.
    let incrementalSince: string | null = null;
    if (!options.from && companyId) {
      try {
        const admin = createAdminClient();
        const { data: syncRow } = await admin
          .from('api_sync_log')
          .select('last_synced_at')
          .eq('company_id', companyId)
          .eq('provider', 'coinsbuy-withdrawals')
          .order('last_synced_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (syncRow?.last_synced_at) {
          const lastSync = new Date(syncRow.last_synced_at);
          lastSync.setHours(lastSync.getHours() - INCREMENTAL_SYNC_OVERLAP_HOURS);
          incrementalSince = lastSync.toISOString();
          console.log(
            `[coinsbuy/payouts] sync incremental desde ${incrementalSince} ` +
              `(último sync: ${syncRow.last_synced_at}, overlap: ${INCREMENTAL_SYNC_OVERLAP_HOURS}h)`,
          );
        } else {
          console.log('[coinsbuy/payouts] sin sync previo, trayendo histórico completo');
        }
      } catch (err) {
        console.warn('[coinsbuy/payouts] no se pudo leer api_sync_log, fallback a histórico completo:', err);
      }
    }

    let page = 1;
    let totalPages = 1;

    do {
      const params = new URLSearchParams();
      params.set('page[size]', String(PAGE_SIZE));
      params.set('page[number]', String(page));
      params.set('ordering', '-created_at');

      const url = `${baseUrl}/transfer/?${params.toString()}`;

      const response: TransferListResponse = await withRetry(async () => {
        const res = await proxiedFetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/vnd.api+json',
          },
          signal: AbortSignal.timeout(12_000),
        });

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          throw new Error(
            `Coinsbuy v3 payouts ${res.status}: ${errBody.slice(0, 200)}`,
          );
        }

        return res.json() as Promise<TransferListResponse>;
      }, { maxAttempts: 2 });

      for (const transfer of response.data ?? []) {
        const attrs = transfer.attributes;

        // ── Client-side filters ──
        // Only payouts (op_type 2) that are confirmed (status 2)
        if (attrs.op_type !== 2) continue;
        if (attrs.status !== 2) continue;

        // Optimización: la API devuelve ordenado por -created_at. Si ya
        // estamos en transfers más viejos que la ventana incremental,
        // podemos cortar la paginación entera (no solo este item).
        if (incrementalSince && attrs.created_at < incrementalSince) {
          // Marcar para terminar el loop externo (do/while)
          page = totalPages + 1;
          break;
        }

        // Optional wallet filter
        if (options.walletId) {
          const walletRelId = transfer.relationships?.wallet?.data?.id;
          if (walletRelId !== options.walletId) continue;
        }

        const amount = Number(attrs.amount ?? 0);
        if (amount <= 0) continue;

        // Optional date range filter
        if (options.from && attrs.created_at < `${options.from}T00:00:00`) continue;
        if (options.to && attrs.created_at > `${options.to}T23:59:59`) continue;

        const commission = Number(attrs.commission ?? 0);
        const chargedAmount = amount + commission;

        allTransactions.push({
          id: transfer.id,
          provider: 'coinsbuy',
          kind: 'withdrawal',
          createdAt: attrs.created_at,
          label: `Withdraw #${attrs.op_id}`,
          trackingId: attrs.txid ?? '',
          amount,
          chargedAmount,
          commission,
          currency: 'USD',
          status: 'Approved',
        });
      }

      totalPages = response.meta?.pagination?.pages ?? 1;
      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    return {
      slug: 'coinsbuy-withdrawals',
      provider: 'coinsbuy',
      kind: 'withdrawals',
      transactions: allTransactions,
      fetchedAt: now,
      status: 'fresh',
      isMock: false,
    };
  } catch (err) {
    return {
      slug: 'coinsbuy-withdrawals',
      provider: 'coinsbuy',
      kind: 'withdrawals',
      transactions: [],
      fetchedAt: now,
      status: 'error',
      isMock: false,
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
