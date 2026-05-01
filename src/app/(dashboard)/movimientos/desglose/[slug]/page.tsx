'use client';

import { useEffect, useMemo, useState, use as useUnwrap } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils';
import { formatDateTime } from '@/lib/dates';
import { downloadCSV } from '@/lib/csv-export';
import {
  ArrowLeft,
  RefreshCw,
  Download,
  ChevronLeft,
  ChevronRight,
  Calendar,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { withActiveCompany } from '@/lib/api-fetch';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { computeProviderTotals, acceptedTransactions } from '@/lib/api-integrations/totals';
import type {
  ProviderDataset,
  ProviderSlug,
  CoinsbuyDepositTx,
  CoinsbuyWithdrawalTx,
  FairpayDepositTx,
  UnipaymentDepositTx,
} from '@/lib/api-integrations/types';

// ─────────────────────────────────────────────────────────────────────────────
// Breakdown page — /movimientos/desglose/[slug]
//
// Shows a filter-driven list of transactions for a single provider, with
// summary cards (total amount, tx count, total fees), pagination (100 per
// page), and CSV export of the currently-filtered rows.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;

const VALID_SLUGS: readonly ProviderSlug[] = [
  'coinsbuy-deposits',
  'coinsbuy-withdrawals',
  'fairpay',
  'unipayment',
] as const;

const SLUG_TITLE: Record<ProviderSlug, string> = {
  'coinsbuy-deposits': 'Coinsbuy · Depósitos',
  'coinsbuy-withdrawals': 'Coinsbuy · Retiros',
  fairpay: 'FairPay · Depósitos',
  unipayment: 'Unipayment · Depósitos',
};

const SLUG_KIND_LABEL: Record<ProviderSlug, { amountCard: string; countCard: string }> = {
  'coinsbuy-deposits': { amountCard: 'Total Depósitos', countCard: 'Total Transacciones' },
  'coinsbuy-withdrawals': { amountCard: 'Total Retiros', countCard: 'Total Transacciones' },
  fairpay: { amountCard: 'Total Depósitos', countCard: 'Total Transacciones' },
  unipayment: { amountCard: 'Total Depósitos', countCard: 'Total Transacciones' },
};

// formatDateTime moved to src/lib/dates.ts — centralised across the app.

export default function BreakdownPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Next.js 16: params and searchParams are Promises — unwrap with React.use()
  const { slug: rawSlug } = useUnwrap(params);
  const initialQuery = useUnwrap(searchParams);
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);

  if (!VALID_SLUGS.includes(rawSlug as ProviderSlug)) {
    notFound();
  }
  const slug = rawSlug as ProviderSlug;

  const initialFrom = typeof initialQuery.from === 'string' ? initialQuery.from : '';
  const initialTo = typeof initialQuery.to === 'string' ? initialQuery.to : '';
  // walletId carried over from /movimientos via the breakdown link so the
  // breakdown filters by the same wallet the cards used. Empty / 'all' = no
  // filter (Todas las wallets).
  const initialWalletId =
    typeof initialQuery.walletId === 'string' ? initialQuery.walletId : '';

  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [dataset, setDataset] = useState<ProviderDataset | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const load = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const qs = new URLSearchParams({ slug });
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      if (initialWalletId) qs.set('walletId', initialWalletId);
      // Read from Supabase (api_transactions), not the live external API.
      // Two reasons:
      //   1. The live endpoint hangs when UniPayment 403s or Coinsbuy is
      //      slow (12s timeouts × retries). Persisted reads stay under 1s.
      //   2. Tarjetas (banner) and breakdown now share the same source —
      //      whatever the card shows, the breakdown shows the same.
      // To pull fresh data the user clicks "Refrescar desde APIs" on the
      // banner up on /movimientos; that endpoint hits live + write-throughs.
      const res = await fetch(
        withActiveCompany(`/api/integrations/persisted-movements?${qs.toString()}`),
      );
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Error desconocido');
      setDataset(json.dataset ?? null);
      setFetchedAt(json.fetchedAt ?? null);
      setPage(1);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setLoading(false);
    }
  };

  // Initial load + refetch whenever the filter changes.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, from, to, initialWalletId]);

  // Show a stale-data hint when the most recent sync for this provider was
  // more than 6 hours ago. The breakdown stays usable — the user can click
  // "Refrescar desde APIs" on the parent /movimientos to trigger a re-sync.
  const dataAgeHours = useMemo(() => {
    if (!fetchedAt) return null;
    const ms = Date.now() - new Date(fetchedAt).getTime();
    return ms / (1000 * 60 * 60);
  }, [fetchedAt]);

  const totals = useMemo(
    () => (dataset ? computeProviderTotals(dataset) : null),
    [dataset]
  );
  const accepted = useMemo(
    () => (dataset ? acceptedTransactions(dataset) : []),
    [dataset]
  );

  const totalPages = Math.max(1, Math.ceil(accepted.length / PAGE_SIZE));
  const pageRows = accepted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleExport = () => verify2FA(() => {
    if (!dataset) return;
    const { headers, rows } = buildCsv(slug, accepted);
    downloadCSV(
      `${slug}_${from || 'all'}_${to || 'all'}.csv`,
      headers,
      rows
    );
  });

  return (
    <div className="space-y-6">
      {Modal2FA}
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <Link
            href="/movimientos"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-1"
          >
            <ArrowLeft className="w-3 h-3" />
            Movimientos
          </Link>
          <h1 className="text-2xl font-bold">{SLUG_TITLE[slug]}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Desglose detallado de transacciones con status{' '}
            <span className="font-medium text-foreground">
              {totals?.acceptedStatus || '—'}
            </span>
            {initialWalletId ? (
              <>
                {' '}· wallet <span className="font-medium text-foreground">{initialWalletId}</span>
              </>
            ) : (
              <>
                {' '}· todas las wallets
              </>
            )}
            .
          </p>
          {dataAgeHours !== null && dataAgeHours > 6 && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 inline-flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Datos del último sync hace {Math.round(dataAgeHours)}h. Volvé a /movimientos y clickeá &quot;Refrescar desde APIs&quot; para datos actualizados.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refrescar</span>
          </button>
          <button
            onClick={handleExport}
            disabled={!dataset || accepted.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">CSV</span>
          </button>
        </div>
      </div>

      {/* Filter */}
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <label className="text-xs text-muted-foreground">Desde</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="px-2 py-1 text-sm rounded-md border border-border bg-card"
          />
          <label className="text-xs text-muted-foreground">Hasta</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="px-2 py-1 text-sm rounded-md border border-border bg-card"
          />
          <button
            onClick={() => {
              setFrom('');
              setTo('');
            }}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground underline"
          >
            Limpiar
          </button>
          {dataset && (
            <span className="text-[10px] text-muted-foreground">
              {dataset.status === 'fresh' ? (
                <CheckCircle2 className="w-3 h-3 text-emerald-500 inline mr-1" />
              ) : (
                <AlertTriangle className="w-3 h-3 text-red-500 inline mr-1" />
              )}
              Actualizado {formatDateTime(dataset.fetchedAt)}
              {dataset.isMock && ' · mock'}
            </span>
          )}
        </div>
        {errorMsg && (
          <div className="mt-2 p-2 rounded bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-xs">
            {errorMsg}
          </div>
        )}
      </Card>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <p className="text-xs text-muted-foreground">
            {SLUG_KIND_LABEL[slug].amountCard}
          </p>
          <p className="text-2xl font-bold mt-1">
            {formatCurrency(totals?.total ?? 0)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            Status: {totals?.acceptedStatus || '—'}
          </p>
        </Card>
        <Card>
          <p className="text-xs text-muted-foreground">
            {SLUG_KIND_LABEL[slug].countCard}
          </p>
          <p className="text-2xl font-bold mt-1">{totals?.count ?? 0}</p>
          <p className="text-[10px] text-muted-foreground mt-1">
            Transacciones aceptadas
          </p>
        </Card>
        <Card>
          <p className="text-xs text-muted-foreground">Fee total</p>
          <p className="text-2xl font-bold mt-1 text-orange-600 dark:text-orange-400">
            {formatCurrency(totals?.feeTotal ?? 0)}
          </p>
          <p className="text-[10px] text-muted-foreground mt-1">
            Comisiones del proveedor
          </p>
        </Card>
      </div>

      {/* Transactions table */}
      <Card>
        <div className="overflow-x-auto">
          <BreakdownTable slug={slug} rows={pageRows} />
        </div>

        {/* Pagination */}
        {accepted.length > 0 && (
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
            <p className="text-xs text-muted-foreground">
              Mostrando {(page - 1) * PAGE_SIZE + 1}–
              {Math.min(page * PAGE_SIZE, accepted.length)} de {accepted.length}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded border border-border hover:bg-muted disabled:opacity-40"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-muted-foreground">
                Página {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-1.5 rounded border border-border hover:bg-muted disabled:opacity-40"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {accepted.length === 0 && !loading && (
          <p className="text-sm text-muted-foreground text-center py-8">
            No hay transacciones en el rango seleccionado.
          </p>
        )}
      </Card>
    </div>
  );
}

// ── Per-provider table renderer ──
// Each provider has its own column set (see the task spec).

function BreakdownTable({
  slug,
  rows,
}: {
  slug: ProviderSlug;
  rows: unknown[];
}) {
  const thCls =
    'text-left py-2 px-2 text-muted-foreground font-medium border-b border-border';
  const tdCls = 'py-2 px-2 border-b border-border/50';

  if (slug === 'coinsbuy-deposits') {
    const r = rows as CoinsbuyDepositTx[];
    return (
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={thCls}>Created at</th>
            <th className={thCls}>Label</th>
            <th className={thCls}>Tracking ID</th>
            <th className={`${thCls} text-right`}>Commission</th>
            <th className={`${thCls} text-right`}>Amount Target</th>
            <th className={thCls}>Status</th>
          </tr>
        </thead>
        <tbody>
          {r.map((t) => (
            <tr key={t.id}>
              <td className={tdCls}>{formatDateTime(t.createdAt)}</td>
              <td className={tdCls}>{t.label}</td>
              <td className={`${tdCls} font-mono`}>{t.trackingId}</td>
              <td className={`${tdCls} text-right`}>{formatCurrency(t.commission)}</td>
              <td className={`${tdCls} text-right font-medium`}>
                {formatCurrency(t.amountTarget)}
              </td>
              <td className={tdCls}>
                <StatusBadge value={t.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (slug === 'coinsbuy-withdrawals') {
    const r = rows as CoinsbuyWithdrawalTx[];
    return (
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={thCls}>Created at</th>
            <th className={thCls}>Label</th>
            <th className={thCls}>Tracking ID</th>
            <th className={`${thCls} text-right`}>Amount</th>
            <th className={`${thCls} text-right`}>Charged Amount</th>
            <th className={`${thCls} text-right`}>Commission</th>
            <th className={thCls}>Status</th>
          </tr>
        </thead>
        <tbody>
          {r.map((t) => (
            <tr key={t.id}>
              <td className={tdCls}>{formatDateTime(t.createdAt)}</td>
              <td className={tdCls}>{t.label}</td>
              <td className={`${tdCls} font-mono`}>{t.trackingId}</td>
              <td className={`${tdCls} text-right`}>{formatCurrency(t.amount)}</td>
              <td className={`${tdCls} text-right font-medium`}>
                {formatCurrency(t.chargedAmount)}
              </td>
              <td className={`${tdCls} text-right`}>{formatCurrency(t.commission)}</td>
              <td className={tdCls}>
                <StatusBadge value={t.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (slug === 'fairpay') {
    const r = rows as FairpayDepositTx[];
    return (
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className={thCls}>Created at</th>
            <th className={thCls}>Customer Email</th>
            <th className={thCls}>ID</th>
            <th className={`${thCls} text-right`}>Billed</th>
            <th className={`${thCls} text-right`}>MDR</th>
            <th className={`${thCls} text-right`}>Net</th>
            <th className={thCls}>Status</th>
          </tr>
        </thead>
        <tbody>
          {r.map((t) => (
            <tr key={t.id}>
              <td className={tdCls}>{formatDateTime(t.createdAt)}</td>
              <td className={tdCls}>{t.customerEmail}</td>
              <td className={`${tdCls} font-mono`}>{t.id}</td>
              <td className={`${tdCls} text-right`}>{formatCurrency(t.billed)}</td>
              <td className={`${tdCls} text-right`}>{formatCurrency(t.mdr)}</td>
              <td className={`${tdCls} text-right font-medium`}>
                {formatCurrency(t.net)}
              </td>
              <td className={tdCls}>
                <StatusBadge value={t.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // Unipayment
  const r = rows as UnipaymentDepositTx[];
  return (
    <table className="w-full text-xs">
      <thead>
        <tr>
          <th className={thCls}>Create Date</th>
          <th className={thCls}>Email</th>
          <th className={thCls}>Order ID</th>
          <th className={`${thCls} text-right`}>Gross Amount</th>
          <th className={`${thCls} text-right`}>Fee</th>
          <th className={`${thCls} text-right`}>Net Amount</th>
          <th className={thCls}>Status</th>
        </tr>
      </thead>
      <tbody>
        {r.map((t) => (
          <tr key={t.id}>
            <td className={tdCls}>{formatDateTime(t.createdAt)}</td>
            <td className={tdCls}>{t.email}</td>
            <td className={`${tdCls} font-mono`}>{t.orderId}</td>
            <td className={`${tdCls} text-right`}>{formatCurrency(t.grossAmount)}</td>
            <td className={`${tdCls} text-right`}>{formatCurrency(t.fee)}</td>
            <td className={`${tdCls} text-right font-medium`}>
              {formatCurrency(t.netAmount)}
            </td>
            <td className={tdCls}>
              <StatusBadge value={t.status} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusBadge({ value }: { value: string }) {
  const ok = ['Confirmed', 'Approved', 'Completed'].includes(value);
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${
        ok
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
          : 'bg-muted text-muted-foreground'
      }`}
    >
      {value}
    </span>
  );
}

// ── CSV builder (per provider column set) ──

function buildCsv(
  slug: ProviderSlug,
  rows: unknown[]
): { headers: string[]; rows: (string | number)[][] } {
  switch (slug) {
    case 'coinsbuy-deposits': {
      const r = rows as CoinsbuyDepositTx[];
      return {
        headers: ['Created at', 'Label', 'Tracking ID', 'Commission', 'Amount Target', 'Status'],
        rows: r.map((t) => [
          t.createdAt,
          t.label,
          t.trackingId,
          t.commission,
          t.amountTarget,
          t.status,
        ]),
      };
    }
    case 'coinsbuy-withdrawals': {
      const r = rows as CoinsbuyWithdrawalTx[];
      return {
        headers: [
          'Created at',
          'Label',
          'Tracking ID',
          'Amount',
          'Charged Amount',
          'Commission',
          'Status',
        ],
        rows: r.map((t) => [
          t.createdAt,
          t.label,
          t.trackingId,
          t.amount,
          t.chargedAmount,
          t.commission,
          t.status,
        ]),
      };
    }
    case 'fairpay': {
      const r = rows as FairpayDepositTx[];
      return {
        headers: ['Created at', 'Customer Email', 'ID', 'Billed', 'MDR', 'Net', 'Status'],
        rows: r.map((t) => [
          t.createdAt,
          t.customerEmail,
          t.id,
          t.billed,
          t.mdr,
          t.net,
          t.status,
        ]),
      };
    }
    case 'unipayment': {
      const r = rows as UnipaymentDepositTx[];
      return {
        headers: [
          'Create Date',
          'Email',
          'Order ID',
          'Gross Amount',
          'Fee',
          'Net Amount',
          'Status',
        ],
        rows: r.map((t) => [
          t.createdAt,
          t.email,
          t.orderId,
          t.grossAmount,
          t.fee,
          t.netAmount,
          t.status,
        ]),
      };
    }
  }
}
