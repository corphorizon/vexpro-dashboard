import { createAdminClient } from '@/lib/supabase/admin';
import { getBalanceWalletIds, getOperatingWalletScope } from '@/lib/pinned-wallets';
import { canonicalAmount, canonicalFee } from './canonical';
import type {
  ProviderDataset,
  ProviderSlug,
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
//
// `canonicalAmount` and `canonicalFee` were extracted to
// `src/lib/api-integrations/canonical.ts` so they can be unit-tested and
// reused by the totals layer without duplicating provider-specific logic.
// ─────────────────────────────────────────────────────────────────────────────

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

  // Pre-fetch external_ids that have already been backfilled with
  // authoritative fee/amount data from a merchant export. The cron's
  // upsert would otherwise replace those values with the fetcher's
  // empirical estimate. Marker is `raw->'_backfilled'` (set when the
  // /tmp backfill SQL ran on 2026-05-02 for UniPayment). Rows with that
  // marker are skipped on upsert so the Excel-sourced fees stay intact.
  const externalIds = dataset.transactions.map((tx) => tx.id);
  const backfilledIds = new Set<string>();
  if (externalIds.length > 0) {
    const { data: existing } = await admin
      .from('api_transactions')
      .select('external_id, raw')
      .eq('company_id', companyId)
      .eq('provider', dataset.slug)
      .in('external_id', externalIds);
    for (const r of existing ?? []) {
      const raw = r.raw as Record<string, unknown> | null;
      if (raw && raw._backfilled) {
        backfilledIds.add(r.external_id as string);
      }
    }
  }

  // Wallet ownership scope — Kevin (2026-06-06 code review).
  //
  // Causa raíz: Vex Pro tenía datos de AP MARKETS y Exura Prime en
  // api_transactions porque la cuenta Coinsbuy del tenant exponía
  // múltiples wallets y el cron persistía TODAS las que la API
  // devolvía. La limpieza ya borró las cross-tenant rows existentes;
  // este check evita que vuelvan a entrar. Set de wallet IDs
  // autorizadas = TODAS las pineadas ∪ {default_wallet_id}. Si
  // está vacío (tenant nuevo sin configurar), permitimos pero
  // capturamos a Sentry para que el operador lo arregle.
  //
  // OJO — acá van TODAS las pineadas, incluidas las internas (migración
  // 084): este es el paso de PERSISTIR, no el de TOTALIZAR. Las wallets
  // internas (Vex Pro: 1087 Savings, 1705 Egresos) tienen que seguir
  // guardando sus transacciones porque de ellas sale el saldo del balance
  // consolidado y el libro del canal. Lo que se restringe a operativas son
  // los TOTALES (loadPersistedTotals más abajo, /movimientos, reportes).
  let allowedWalletIds: Set<string> | null = null;
  if (dataset.slug === 'coinsbuy-deposits' || dataset.slug === 'coinsbuy-withdrawals') {
    const [balanceWalletIds, companyRes] = await Promise.all([
      getBalanceWalletIds(companyId),
      admin
        .from('companies')
        .select('default_wallet_id')
        .eq('id', companyId)
        .maybeSingle(),
    ]);
    const ids = new Set<string>(balanceWalletIds);
    if (companyRes.data?.default_wallet_id) {
      ids.add(String(companyRes.data.default_wallet_id));
    }
    if (ids.size > 0) {
      allowedWalletIds = ids;
    } else {
      try {
        const Sentry = await import('@sentry/nextjs');
        Sentry.captureMessage('persistDataset: no wallet scope configured', {
          level: 'warning',
          tags: { area: 'persistence', companyId, provider: dataset.slug },
        });
      } catch {
        console.warn(
          `[persistDataset] ${dataset.slug} company ${companyId} has no pinned wallets and no default_wallet_id — accepting all wallet IDs (legacy). Configure to prevent cross-tenant data.`,
        );
      }
    }
  }

  let rejectedCount = 0;
  const rows = dataset.transactions
    .filter((tx) => !backfilledIds.has(tx.id))
    .map((tx) => {
      // Coinsbuy txs carry walletId + walletLabel after the 2026-05-01 fetcher
      // change. FairPay / UniPayment txs don't have wallet semantics so we
      // leave both fields null for those providers.
      const walletId =
        'walletId' in tx && typeof tx.walletId === 'string' ? tx.walletId : null;
      const walletLabel =
        'walletLabel' in tx && typeof tx.walletLabel === 'string'
          ? tx.walletLabel
          : null;
      // Transferencia interna entre wallets propias (solo coinsbuy-withdrawals
      // hoy: txid null en la API v3 → el fetcher setea `internal: true`).
      // Se persiste como columna propia para que las agregaciones SQL
      // (get_period_totals_by_month, reports) puedan filtrarla sin abrir `raw`.
      const internal =
        'internal' in tx && (tx as { internal?: boolean }).internal === true;
      return {
        company_id: companyId,
        provider: dataset.slug,
        external_id: tx.id,
        amount: canonicalAmount(tx),
        fee: canonicalFee(tx),
        currency: tx.currency ?? null,
        status: tx.status ?? null,
        transaction_date: tx.createdAt,
        wallet_id: walletId,
        wallet_label: walletLabel,
        internal,
        raw: tx as unknown as Record<string, unknown>,
        synced_at: new Date().toISOString(),
      };
    })
    .filter((row) => {
      if (!allowedWalletIds) return true;
      if (!row.wallet_id) return true; // non-coinsbuy rows (shouldn't happen here)
      if (allowedWalletIds.has(String(row.wallet_id))) return true;
      rejectedCount++;
      return false;
    });

  if (rejectedCount > 0) {
    try {
      const Sentry = await import('@sentry/nextjs');
      Sentry.captureMessage('persistDataset: rejected wallet rows', {
        level: 'warning',
        tags: { area: 'persistence.wallet_scope', companyId, provider: dataset.slug },
        extra: { rejectedCount, allowed: Array.from(allowedWalletIds ?? []) },
      });
    } catch {
      console.warn(
        `[persistDataset] ${dataset.slug} rejected ${rejectedCount} rows with wallet_id outside the tenant's authorized set`,
      );
    }
  }

  if (rows.length > 0) {
    const { error } = await admin
      .from('api_transactions')
      .upsert(rows, { onConflict: 'company_id,provider,external_id' });

    if (error) {
      console.error(`[persistDataset] ${dataset.slug} upsert failed:`, error.message);
      return;
    }
  }

  if (backfilledIds.size > 0) {
    console.log(
      `[persistDataset] ${dataset.slug}: preserved ${backfilledIds.size} backfilled rows from overwrite`,
    );
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
 *
 * Scope de wallets (migración 084): los totales son de MOVIMIENTOS, así que
 * las filas de Coinsbuy se restringen a las wallets pineadas OPERATIVAS. Las
 * internas —tesorería propia: ahorro, pago de egresos— suman al balance pero
 * no son depósitos ni retiros de clientes. Sin este filtro, agosto 2026 de
 * Vex Pro daba $932.444,83 de retiros ($469.650,98 de la Main 1079 +
 * $400.014,00 de Savings 1087 + $62.779,85 de Egresos 1705) y un Net Deposit
 * de −$231.127 que se iba derecho a la cadena de distribución.
 * Si el tenant no tiene ninguna operativa configurada no se filtra nada
 * (mismo fallback permisivo que /api/integrations/persisted-movements).
 */
export async function loadPersistedTotals(
  companyId: string,
  from: string,
  to: string,
  walletId?: string,
): Promise<PersistedTotals> {
  const admin = createAdminClient();
  const walletScope = await getOperatingWalletScope(companyId);
  const operatingWalletIds = new Set(walletScope.ids);

  // Inclusive date range: interpret `to` as end-of-day.
  const fromISO = `${from}T00:00:00.000Z`;
  const toISO = `${to}T23:59:59.999Z`;

  let query = admin
    .from('api_transactions')
    .select('provider, amount, status, transaction_date, wallet_id, internal')
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

  // Pay-Pros entra por webhook (modelo push) y NO pasa por ProviderDataset ni
  // tiene slug propio en `by` todavía: sus filas viven en api_transactions
  // con provider='paypros' y un status que ya distingue depósito de retiro
  // ('paid' = cash/bank cobrado, 'payout_paid' = payout ejecutado). Se suman
  // aparte a los totales de depósitos/retiros para que Net Deposit las vea
  // desde el primer aviso; el desglose por pantalla llega en la tanda de UI
  // (ampliar ProviderSlug arrastra 7 Records exhaustivos).
  let payprosDeposits = 0;
  let payprosPayouts = 0;

  for (const row of data) {
    if (row.provider === 'paypros') {
      const amt = Number(row.amount) || 0;
      if (row.status === 'paid') payprosDeposits += amt;
      else if (row.status === 'payout_paid') payprosPayouts += amt;
      continue;
    }
    const slug = row.provider as ProviderSlug;
    if (!(slug in by)) continue;
    // Solo wallets operativas para las filas de Coinsbuy (ver docstring).
    // Las filas sin wallet_id (persistidas antes de la migración 041) se
    // dejan pasar para no vaciar el histórico.
    if (
      (slug === 'coinsbuy-deposits' || slug === 'coinsbuy-withdrawals') &&
      walletScope.scoped &&
      row.wallet_id &&
      !operatingWalletIds.has(String(row.wallet_id))
    ) {
      continue;
    }
    const accepted = ACCEPTED[slug];
    if (row.status && !accepted.includes(row.status)) continue;
    // Transferencias internas entre wallets propias (txid null en Coinsbuy):
    // no cuentan en Retiros Totales ni Net Deposit. Solo aplica al lado de
    // retiros — el lado receptor no aparece como depósito (verificado).
    if (slug === 'coinsbuy-withdrawals' && row.internal === true) continue;
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
    depositsTotal: by['coinsbuy-deposits'] + by.fairpay + by.unipayment + payprosDeposits,
    withdrawalsTotal: by['coinsbuy-withdrawals'] + payprosPayouts,
    lastSyncedAt: syncRows?.[0]?.last_synced_at ?? null,
  };
}
