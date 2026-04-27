// ─────────────────────────────────────────────────────────────────────────────
// External-API sync — multi-tenant fan-out for Coinsbuy / FairPay /
// UniPayment / Orion CRM. Mirrors what the user-facing
// /api/integrations/movements endpoint does, but for every tenant in
// parallel and on a schedule (cron) instead of on-demand.
//
// Each provider's fetcher is already multi-tenant aware — pass `companyId`
// and it resolves credentials from `api_credentials` (falling back to env
// when no per-tenant row exists).
//
// Idempotent: writes go through `persistDataset` which upserts on
// (company_id, provider, external_id) so re-running the same window
// produces zero duplicates.
//
// Designed for two callers:
//   1. /api/cron/sync-external-apis — the periodic job (every 6 h).
//   2. /api/cron/daily-financial-report — safety net: if the most recent
//      sync is older than the threshold (default 15 min), trigger a fresh
//      one before sending the email.
// ─────────────────────────────────────────────────────────────────────────────

import { createAdminClient } from '@/lib/supabase/admin';
import { fetchCoinsbuyTransfers } from '@/lib/api-integrations/coinsbuy/transfers';
import { fetchFairpayDeposits } from '@/lib/api-integrations/fairpay/transactions';
import { fetchUnipaymentDepositsV2 } from '@/lib/api-integrations/unipayment/transactions';
import { fetchOrionCrmTotals } from '@/lib/api-integrations/orion-crm/totals';
import { fetchOrionCrmUsers } from '@/lib/api-integrations/orion-crm/users';
import { fetchOrionCrmBrokerPnl } from '@/lib/api-integrations/orion-crm/broker-pnl';
import { fetchOrionCrmPropTrading } from '@/lib/api-integrations/orion-crm/prop-trading';
import { isOrionCrmConfigured } from '@/lib/api-integrations/orion-crm/auth';
import { persistDataset } from '@/lib/api-integrations/persistence';

export interface SyncProviderResult {
  company_id: string;
  company_name: string;
  provider: string;
  status: 'ok' | 'error' | 'skipped';
  records?: number;
  error?: string;
}

export interface SyncRunSummary {
  ranAt: string;
  windowFrom: string;
  windowTo: string;
  companies_processed: number;
  apis_called: number;
  apis_failed: number;
  details: SyncProviderResult[];
}

/**
 * Default sync window — last 35 days. Wide enough to (a) capture
 * everything the daily report needs (it summarises "yesterday" + the
 * current month + the previous month, so 35d covers the boundary), and
 * (b) keep idempotent upserts cheap (~thousands of rows max per tenant).
 */
function defaultWindow(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 35);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

/**
 * Run the sync for every active tenant that has the `movements` module
 * enabled. Per-provider failures are isolated and reported in `details`,
 * never thrown.
 */
export async function runExternalApiSync(opts: {
  windowFrom?: string;
  windowTo?: string;
  onlyCompanyId?: string | null;
} = {}): Promise<SyncRunSummary> {
  const ranAt = new Date().toISOString();
  const window = {
    from: opts.windowFrom ?? defaultWindow().from,
    to: opts.windowTo ?? defaultWindow().to,
  };

  const admin = createAdminClient();
  let q = admin
    .from('companies')
    .select('id, name, active_modules, status')
    .neq('status', 'inactive');
  if (opts.onlyCompanyId) q = q.eq('id', opts.onlyCompanyId);

  const { data: companies, error } = await q;
  if (error || !companies) {
    throw new Error(`runExternalApiSync: cannot list companies — ${error?.message ?? 'no rows'}`);
  }

  // Only sync tenants that actually use Movimientos. Skipping the rest
  // saves API quota on Coinsbuy / Fairpay / UniPayment.
  const eligible = companies.filter(
    (c) => Array.isArray(c.active_modules) && c.active_modules.includes('movements'),
  );

  // Per-tenant work — parallelised. Each provider call inside one tenant
  // runs concurrently too. Promise.allSettled isolates failures.
  const perTenant = await Promise.all(
    eligible.map(async (company) => {
      const tasks: Promise<SyncProviderResult[]>[] = [];

      // ── Coinsbuy (deposits + payouts in a single call) ────────────────
      tasks.push(
        (async () => {
          try {
            const cb = await fetchCoinsbuyTransfers({
              from: window.from,
              to: window.to,
              companyId: company.id,
            });
            const out: SyncProviderResult[] = [];
            for (const ds of [cb.deposits, cb.payouts]) {
              if (ds.status === 'error') {
                out.push({
                  company_id: company.id,
                  company_name: company.name,
                  provider: ds.slug,
                  status: 'error',
                  error: ds.errorMessage ?? 'unknown',
                });
              } else {
                await persistDataset(company.id, ds, {
                  from: window.from,
                  to: window.to,
                });
                out.push({
                  company_id: company.id,
                  company_name: company.name,
                  provider: ds.slug,
                  status: 'ok',
                  records: ds.transactions?.length ?? 0,
                });
              }
            }
            return out;
          } catch (err) {
            return [
              {
                company_id: company.id,
                company_name: company.name,
                provider: 'coinsbuy',
                status: 'error' as const,
                error: err instanceof Error ? err.message : 'unknown',
              },
            ];
          }
        })(),
      );

      // ── FairPay ───────────────────────────────────────────────────────
      tasks.push(
        (async () => {
          try {
            const ds = await fetchFairpayDeposits({
              from: window.from,
              to: window.to,
              companyId: company.id,
            });
            if (ds.status === 'error') {
              return [
                {
                  company_id: company.id,
                  company_name: company.name,
                  provider: 'fairpay',
                  status: 'error' as const,
                  error: ds.errorMessage ?? 'unknown',
                },
              ];
            }
            await persistDataset(company.id, ds, { from: window.from, to: window.to });
            return [
              {
                company_id: company.id,
                company_name: company.name,
                provider: 'fairpay',
                status: 'ok' as const,
                records: ds.transactions?.length ?? 0,
              },
            ];
          } catch (err) {
            return [
              {
                company_id: company.id,
                company_name: company.name,
                provider: 'fairpay',
                status: 'error' as const,
                error: err instanceof Error ? err.message : 'unknown',
              },
            ];
          }
        })(),
      );

      // ── UniPayment ────────────────────────────────────────────────────
      tasks.push(
        (async () => {
          try {
            const ds = await fetchUnipaymentDepositsV2({
              from: window.from,
              to: window.to,
              companyId: company.id,
            });
            if (ds.status === 'error') {
              return [
                {
                  company_id: company.id,
                  company_name: company.name,
                  provider: 'unipayment',
                  status: 'error' as const,
                  error: ds.errorMessage ?? 'unknown',
                },
              ];
            }
            await persistDataset(company.id, ds, { from: window.from, to: window.to });
            return [
              {
                company_id: company.id,
                company_name: company.name,
                provider: 'unipayment',
                status: 'ok' as const,
                records: ds.transactions?.length ?? 0,
              },
            ];
          } catch (err) {
            return [
              {
                company_id: company.id,
                company_name: company.name,
                provider: 'unipayment',
                status: 'error' as const,
                error: err instanceof Error ? err.message : 'unknown',
              },
            ];
          }
        })(),
      );

      // ── Orion CRM (only if configured for this tenant) ────────────────
      // Currently we don't persist Orion results to a snapshot table —
      // the report builder calls Orion live. We DO call the endpoints to
      // (a) verify connectivity and (b) prime any provider-side caches
      // that Orion might keep. When a snapshot table is added later this
      // is the right hook to populate it.
      tasks.push(
        (async () => {
          const configured = await isOrionCrmConfigured(company.id);
          if (!configured) {
            return [
              {
                company_id: company.id,
                company_name: company.name,
                provider: 'orion_crm',
                status: 'skipped' as const,
              },
            ];
          }
          try {
            const [usersRes, pnlRes, propRes, totalsRes] = await Promise.all([
              fetchOrionCrmUsers(company.id, window.from, window.to),
              fetchOrionCrmBrokerPnl(company.id, window.from, window.to),
              fetchOrionCrmPropTrading(company.id, window.from, window.to),
              fetchOrionCrmTotals(company.id, window.from, window.to),
            ]);
            const allConnected =
              usersRes.connected && pnlRes.connected && propRes.connected && totalsRes.connected;
            return [
              {
                company_id: company.id,
                company_name: company.name,
                provider: 'orion_crm',
                status: allConnected ? ('ok' as const) : ('error' as const),
                records: allConnected ? 4 : 0,
                error: allConnected
                  ? undefined
                  : usersRes.errorMessage ??
                    pnlRes.errorMessage ??
                    propRes.errorMessage ??
                    totalsRes.errorMessage ??
                    'orion endpoints reachable but returned mock/empty',
              },
            ];
          } catch (err) {
            return [
              {
                company_id: company.id,
                company_name: company.name,
                provider: 'orion_crm',
                status: 'error' as const,
                error: err instanceof Error ? err.message : 'unknown',
              },
            ];
          }
        })(),
      );

      const results = await Promise.all(tasks);
      return results.flat();
    }),
  );

  const details = perTenant.flat();
  const apisOk = details.filter((d) => d.status === 'ok').length;
  const apisFailed = details.filter((d) => d.status === 'error').length;

  // Audit log: a single row summarising the run, plus structured details
  // in `details`. Used by the report cron to verify a fresh sync exists.
  await admin.from('audit_logs').insert({
    company_id: null,
    user_id: null,
    user_name: 'cron',
    action: 'sync',
    module: 'integrations_sync',
    details: JSON.stringify({
      ranAt,
      window,
      companies_processed: eligible.length,
      apis_called: apisOk + apisFailed,
      apis_failed: apisFailed,
      results: details,
    }),
  });

  return {
    ranAt,
    windowFrom: window.from,
    windowTo: window.to,
    companies_processed: eligible.length,
    apis_called: apisOk + apisFailed,
    apis_failed: apisFailed,
    details,
  };
}

/**
 * Returns the most recent sync run summary (or null), with a hint about
 * whether all providers succeeded for the given company. Used by the
 * report safety-net to decide if it should run an inline re-sync — a
 * "successful" sync where one provider 403'd is NOT good enough.
 */
export interface LastSyncStatus {
  /** ISO timestamp of when the sync ran. */
  ranAt: string;
  /** True iff every provider that's NOT 'skipped' reported status='ok'.
   *  When false, the safety-net should re-run the sync. */
  allOk: boolean;
  /** Per-tenant tally so callers can decide more precisely. */
  perCompanyFailed: Record<string, string[]>;
}

export async function getLastSyncStatus(
  onlyCompanyId?: string | null,
): Promise<LastSyncStatus | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('audit_logs')
    .select('created_at, details')
    .eq('module', 'integrations_sync')
    .eq('action', 'sync')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;

  let parsed: { ranAt?: string; results?: SyncProviderResult[] } | null = null;
  try {
    parsed = typeof data.details === 'string' ? JSON.parse(data.details) : data.details;
  } catch {
    return { ranAt: data.created_at, allOk: false, perCompanyFailed: {} };
  }

  const ranAt = parsed?.ranAt ?? data.created_at;
  const results = parsed?.results ?? [];
  const perCompanyFailed: Record<string, string[]> = {};
  let allOk = true;

  for (const r of results) {
    if (r.status === 'error') {
      // Filter out tenants we don't care about for this safety-net check.
      if (onlyCompanyId && r.company_id !== onlyCompanyId) continue;
      perCompanyFailed[r.company_id] = perCompanyFailed[r.company_id] ?? [];
      perCompanyFailed[r.company_id].push(r.provider);
      allOk = false;
    }
  }

  return { ranAt, allOk, perCompanyFailed };
}

/** Backwards-compat shim — returns just the timestamp. */
export async function getLastSyncAt(): Promise<string | null> {
  const s = await getLastSyncStatus();
  return s?.ranAt ?? null;
}
