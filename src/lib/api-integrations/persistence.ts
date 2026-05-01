import { createAdminClient } from '@/lib/supabase/admin';
import type {
  ProviderDataset,
  ProviderSlug,
  ProviderTransaction,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// API Persistence — write-through of fetched datasets to Supabase.
//
// Triggered from /api/integrations/movements after a successful aggregator
// fetch. Idempotent: repeated fetches of the same window upsert the same
// transactions (keyed on company_id + provider + external_id) instead of
// creating duplicates. Balance snapshots and sync logs are append-only.
//
// Failures are logged but never thrown — persistence must not break the
// realtime user-facing response.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the canonical amount for a provider transaction — matches what
 * computeProviderTotals sums up in totals.ts.
 */
function canonicalAmount(tx: ProviderTransaction): number {
  if ('amountTarget' in tx) return tx.amountTarget ?? 0;       // coinsbuy deposit
  if ('chargedAmount' in tx) return tx.chargedAmount ?? 0;     // coinsbuy withdrawal
  if ('net' in tx) return tx.net ?? 0;                          // fairpay
  if ('netAmount' in tx) return tx.netAmount ?? 0;              // unipayment
  return 0;
}

function canonicalFee(tx: ProviderTransaction): number {
  if ('commission' in tx) return tx.commission ?? 0;
  if ('mdr' in tx) return tx.mdr ?? 0;
  if ('fee' in tx) return tx.fee ?? 0;
  return 0;
}

/**
 * Persist a single ProviderDataset. Upserts all transactions keyed on
 * (company_id, provider, external_id), then appends one sync-log row.
 * Silently ignores error/stale datasets.
 */
export async function persistDataset(
  companyId: string,
  dataset: ProviderDataset,
  opts: { from?: string; to?: string } = {},
): Promise<void> {
  if (dataset.status !== 'fresh') return;
  if (dataset.isMock) return;                // don't pollute DB with mock rows
  if (!dataset.transactions.length) {
    // Still log an empty sync so we can tell "we asked and got nothing" apart
    // from "we never asked".
    await logSync(companyId, dataset.slug, 0, opts);
    return;
  }

  const admin = createAdminClient();

  const rows = dataset.transactions.map((tx) => ({
    company_id: companyId,
    provider: dataset.slug,
    external_id: tx.id,
    amount: canonicalAmount(tx),
    fee: canonicalFee(tx),
    currency: tx.currency ?? null,
    status: tx.status ?? null,
    transaction_date: tx.createdAt,
    wallet_id: null, // coinsbuy wallet_id isn't on the transaction row today
    raw: tx as unknown as Record<string, unknown>,
    synced_at: new Date().toISOString(),
  }));

  const { error } = await admin
    .from('api_transactions')
    .upsert(rows, { onConflict: 'company_id,provider,external_id' });

  if (error) {
    console.error(`[persistDataset] ${dataset.slug} upsert failed:`, error.message);
    return;
  }

  await logSync(companyId, dataset.slug, rows.length, opts);
}

async function logSync(
  companyId: string,
  provider: ProviderSlug,
  txCount: number,
  opts: { from?: string; to?: string },
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from('api_sync_log').insert({
    company_id: companyId,
    provider,
    period_from: opts.from ?? null,
    period_to: opts.to ?? null,
    tx_count: txCount,
    last_synced_at: new Date().toISOString(),
  });
  if (error) console.error('[logSync] failed:', error.message);
}

/**
 * Persist a point-in-time balance reading. Fire-and-forget from wallet
 * endpoints (Coinsbuy /wallets, UniPayment /balances).
 */
export async function persistBalanceSnapshot(
  companyId: string,
  provider: 'coinsbuy' | 'fairpay' | 'unipayment',
  balance: number,
  options: { walletId?: string; currency?: string } = {},
): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from('api_balance_snapshots').insert({
      company_id: companyId,
      provider,
      wallet_id: options.walletId ?? null,
      balance,
      currency: options.currency ?? null,
      captured_at: new Date().toISOString(),
    });
    if (error) console.error('[persistBalanceSnapshot]', provider, 'failed:', error.message);
  } catch (err) {
    console.error('[persistBalanceSnapshot] unhandled', err instanceof Error ? err.message : err);
  }
}

// ─── Read helpers ────────────────────────────────────────────────────────

export interface PersistedTotals {
  by: Record<ProviderSlug, number>;
  depositsTotal: number;
  withdrawalsTotal: number;
  lastSyncedAt: string | null;
}

/**
 * Sum persisted transactions for a company over a date range.
 * Used when the live API is unreachable OR when Movimientos / Resumen
 * General want a consistent historical answer.
 */
export async function loadPersistedTotals(
  companyId: string,
  from: string,
  to: string,
  walletId?: string,
): Promise<PersistedTotals> {
  const admin = createAdminClient();

  // Inclusive date range: interpret `to` as end-of-day.
  const fromISO = `${from}T00:00:00.000Z`;
  const toISO = `${to}T23:59:59.999Z`;

  let query = admin
    .from('api_transactions')
    .select('provider, amount, status, transaction_date, wallet_id')
    .eq('company_id', companyId)
    .gte('transaction_date', fromISO)
    .lte('transaction_date', toISO)
    // Defensive cap — typical month is <10K rows; this protects against a
    // pathological multi-year range silently consuming memory.
    .limit(10000);

  if (walletId) {
    // Only apply filter for rows that have a wallet_id — others (fairpay/uni)
    // always match.
    query = query.or(`wallet_id.eq.${walletId},wallet_id.is.null`);
  }

  const { data, error } = await query;
  if (error || !data) {
    console.error('[loadPersistedTotals] query failed:', error?.message);
    return {
      by: { 'coinsbuy-deposits': 0, 'coinsbuy-withdrawals': 0, fairpay: 0, unipayment: 0 },
      depositsTotal: 0,
      withdrawalsTotal: 0,
      lastSyncedAt: null,
    };
  }

  const by: Record<ProviderSlug, number> = {
    'coinsbuy-deposits': 0,
    'coinsbuy-withdrawals': 0,
    fairpay: 0,
    unipayment: 0,
  };

  const ACCEPTED: Record<ProviderSlug, string[]> = {
    'coinsbuy-deposits': ['Confirmed'],
    'coinsbuy-withdrawals': ['Approved'],
    fairpay: ['Completed'],
    unipayment: ['Completed'],
  };

  for (const row of data) {
    const slug = row.provider as ProviderSlug;
    if (!(slug in by)) continue;
    const accepted = ACCEPTED[slug];
    if (row.status && !accepted.includes(row.status)) continue;
    by[slug] += Number(row.amount) || 0;
  }

  // Fetch last sync per provider
  const { data: syncRows } = await admin
    .from('api_sync_log')
    .select('last_synced_at')
    .eq('company_id', companyId)
    .order('last_synced_at', { ascending: false })
    .limit(1);

  return {
    by,
    depositsTotal: by['coinsbuy-deposits'] + by.fairpay + by.unipayment,
    withdrawalsTotal: by['coinsbuy-withdrawals'],
    lastSyncedAt: syncRows?.[0]?.last_synced_at ?? null,
  };
}
