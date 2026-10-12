'use client';

import { useEffect, useMemo, useState, use as useUnwrap } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, RefreshCw, Download, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, kpiPlainText, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import { formatDateRelative, formatDateTime } from '@/lib/dates';
import { formatMoney } from '@/lib/money';
import { downloadCSV } from '@/lib/csv-export';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { apiFetch } from '@/lib/api-fetch';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { PROVIDER_META } from '@/lib/api-channels';
import {
  computeProviderTotals,
  acceptedTransactions,
  countPayprosPayouts,
} from '@/lib/api-integrations/totals';
import {
  countedNet,
  dailyNet,
  dayKey,
  filterLedger,
  ledgerCounts,
  ledgerRows,
  signedAmount,
  timeOf,
  type LedgerCategory,
  type LedgerDirection,
  type LedgerRow,
} from '@/lib/movements-ledger';
import { ExcludeToggleButton } from './_components/exclude-toggle-button';
import type {
  ProviderDataset,
  ProviderSlug,
  CoinsbuyDepositTx,
  CoinsbuyWithdrawalTx,
  FairpayDepositTx,
  UnipaymentDepositTx,
  PayprosDepositTx,
} from '@/lib/api-integrations/types';

// ─────────────────────────────────────────────────────────────────────────────
// /movimientos/desglose/[slug] — el LIBRO de movimientos de un proveedor.
//
// REDISEÑO «Libro mayor» (2026-10-12, docs/diseno-libro-mayor.md §5.3):
// /movimientos sólo muestra totales por canal; el detalle por operación vive
// acá, así que el libro de movimientos de la propuesta A se aplicó a esta
// pantalla. Antes había cinco tablas a mano (una por proveedor, `text-xs`,
// textos de 10 px, un StatusBadge local con verde para cuatro status y gris
// para todo lo demás) y tres tarjetas sueltas. Ahora:
//   · KPIs en una franja (total, operaciones, comisiones, pendientes).
//   · UNA FinTable agrupada por DÍA con el neto diario en la fila de grupo,
//     columnas Hora · Cliente·ID · Canal · Tipo · Estado · Monto (+ comisión).
//     El neto del día se calcula sobre TODA la lista filtrada, no sobre la
//     página: un día partido entre dos páginas no muestra medio neto.
//   · Lo que NO cuenta se ve y se dice: rechazadas y excluidas tachadas en
//     `text-3`, internas atenuadas. Antes la tabla mostraba sólo el status
//     aceptado y escondía pendientes y rechazadas sin contarlas; ahora cada
//     categoría es un Chip con su conteo y el pie dice «Mostrando N de M · los
//     totales usan las K que cuentan».
//   · `Segmented` Todos/Depósitos/Retiros cuando el proveedor trae los dos
//     sentidos (Pay-Pros). Los payouts de Pay-Pros, que antes sólo se
//     mencionaban en un cartel, se listan con su sentido (no entran al total
//     de depósitos: lo dice el aviso).
//
// MEDICIÓN: los KPIs siguen saliendo de `computeProviderTotals` /
// `countPayprosPayouts` (lo que suma /movimientos). La marca «cuenta» de cada
// fila (src/lib/movements-ledger.ts) usa los mismos criterios y su test fija
// Σ filas que cuentan === total canónico por proveedor.
//
// DESCARTADO:
//   · Paginar dentro de FinTable: la tabla no pagina (esconde cuántas filas
//     hay); la página arma la porción y el pie la cuenta.
//   · Ocultar por defecto pendientes/rechazadas sin chip: era el recorte
//     silencioso de antes. Por defecto se ven las que cuentan (como antes),
//     pero los chips muestran cuántas hay de cada otra categoría.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;

const VALID_SLUGS: readonly ProviderSlug[] = [
  'coinsbuy-deposits',
  'coinsbuy-withdrawals',
  'fairpay',
  'unipayment',
  // Pay-Pros se lee del espejo (api_transactions) como todos: esta pantalla
  // ya leía de /persisted-movements, no de la API en vivo.
  'paypros',
] as const;

/** Orden de los chips de categoría. */
const CATEGORY_ORDER: readonly LedgerCategory[] = ['counts', 'pending', 'rejected', 'excluded', 'internal', 'other'];

/** Lo que se ve al entrar: lo que cuenta (y las internas, que antes también se veían). */
const DEFAULT_CATEGORIES: readonly LedgerCategory[] = ['counts', 'internal'];

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
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);

  if (!VALID_SLUGS.includes(rawSlug as ProviderSlug)) {
    notFound();
  }
  const slug = rawSlug as ProviderSlug;
  // Providers que soportan exclusión manual (mismo set que la whitelist del
  // endpoint POST /api/integrations/excluded-transactions).
  const supportsExclusion =
    slug === 'coinsbuy-deposits' || slug === 'coinsbuy-withdrawals';

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
  const [direction, setDirection] = useState<'all' | LedgerDirection>('all');
  const [categories, setCategories] = useState<readonly LedgerCategory[]>(DEFAULT_CATEGORIES);
  // Buscador libre client-side: filtra las filas visibles sin tocar los KPIs
  // de arriba ni el CSV export.
  const [searchQuery, setSearchQuery] = useState('');
  // «Ahora» para la antigüedad del dato, tomado al montar (render puro).
  const [now] = useState(() => Date.now());

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
      // To pull fresh data the user clicks «Sincronizar ahora» on the
      // panel down on /movimientos; that endpoint hits live + write-throughs.
      const res = await apiFetch(`/api/integrations/persisted-movements?${qs.toString()}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || t('movements.ledger.unknownError'));
      setDataset(json.dataset ?? null);
      setFetchedAt(json.fetchedAt ?? null);
      setPage(1);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('movements.ledger.networkError'));
    } finally {
      setLoading(false);
    }
  };

  // Initial load + refetch whenever the filter changes.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, from, to, initialWalletId]);

  // Datos de un sync de hace más de 6 h: el número sigue (suma), pero se
  // marca viejo — cada número dice de cuándo es.
  const dataAgeHours = useMemo(() => {
    if (!fetchedAt) return null;
    return (now - new Date(fetchedAt).getTime()) / (1000 * 60 * 60);
  }, [fetchedAt, now]);
  const isStale = dataAgeHours !== null && dataAgeHours > 6;

  const totals = useMemo(() => (dataset ? computeProviderTotals(dataset) : null), [dataset]);
  // CSV: las filas con el status aceptado, como siempre (incluye excluidas).
  const accepted = useMemo(() => (dataset ? acceptedTransactions(dataset) : []), [dataset]);
  // Payouts de Pay-Pros: se listan con el filtro «Retiros» pero NO entran al
  // total de depósitos de arriba. `countPayprosPayouts` da {0,0} en otro slug.
  const payprosPayouts = useMemo(
    () => (dataset ? countPayprosPayouts(dataset) : { count: 0, total: 0 }),
    [dataset],
  );

  // ── El libro ──
  const allRows = useMemo(() => (dataset ? ledgerRows(dataset) : []), [dataset]);
  const counts = useMemo(() => ledgerCounts(allRows), [allRows]);
  const hasBothDirections = counts.deposit > 0 && counts.withdrawal > 0;
  const effectiveDirection = hasBothDirections ? direction : 'all';
  // Conteos de los chips: dentro del sentido elegido, antes del buscador.
  const byDirection = useMemo(
    () => filterLedger(allRows, { direction: effectiveDirection, categories: [], query: '' }),
    [allRows, effectiveDirection],
  );
  const chipCounts = useMemo(() => ledgerCounts(byDirection).byCategory, [byDirection]);
  const filtered = useMemo(
    () =>
      filterLedger(allRows, {
        direction: effectiveDirection,
        // Un chip activo sin filas no filtra: si ninguna categoría activa
        // tiene filas se ve TODO, nunca una tabla vacía que parezca «no hay».
        categories: categories.filter((c) => chipCounts[c] > 0),
        query: searchQuery,
      }),
    [allRows, effectiveDirection, categories, chipCounts, searchQuery],
  );
  const dayNets = useMemo(() => dailyNet(filtered), [filtered]);
  const filteredNet = useMemo(() => countedNet(filtered), [filtered]);
  const filteredCounting = filtered.filter((r) => r.counts).length;
  const countingAll = counts.byCategory.counts;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const toggleCategory = (c: LedgerCategory) => {
    setCategories((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
    setPage(1);
  };

  const handleExport = () => verify2FA(() => {
    if (!dataset) return;
    const { headers, rows } = buildCsv(slug, accepted);
    downloadCSV(
      `${slug}_${from || 'all'}_${to || 'all'}.csv`,
      headers,
      rows
    );
  });

  // ── KPIs ──
  const isPaypros = slug === 'paypros';
  const pendingRows = allRows.filter((r) => r.category === 'pending');
  const pendingAmount = pendingRows.reduce((s, r) => s + r.amount, 0);
  const amountLabel =
    PROVIDER_META[slug].direction === 'out' ? t('movements.ledger.kpi.totalOut') : t('movements.ledger.kpi.totalIn');
  const kpis: KpiItem[] = [
    {
      key: 'total',
      label: amountLabel,
      value: totals ? totals.total : null,
      format: 'money',
      tone: 'neutral',
      hero: true,
      staleAt: isStale ? fetchedAt : null,
      sub: totals ? t('movements.ledger.kpi.status', { status: totals.acceptedStatus }) : null,
    },
    {
      key: 'count',
      label: t('movements.ledger.kpi.count'),
      value: totals ? totals.count + payprosPayouts.count : null,
      format: 'count',
      sub:
        isPaypros && totals
          ? t('movements.ledger.kpi.countSplit', {
              d: kpiPlainText(totals.count, 'count'),
              w: kpiPlainText(payprosPayouts.count, 'count'),
            })
          : t('movements.ledger.kpi.countSub'),
    },
    {
      key: 'fee',
      label: t('movements.ledger.kpi.fee'),
      // Pay-Pros no informa comisión: «—» con el porqué, no un $0.00 que
      // afirmaría que no cobró nada (reglas §1.3).
      value: totals && !isPaypros ? totals.feeTotal : null,
      format: 'money',
      tone: 'neutral',
      sub: isPaypros ? t('movements.ledger.kpi.feeNotReported') : t('movements.ledger.kpi.feeSub'),
    },
    {
      key: 'pending',
      label: t('movements.kpi.pending'),
      value: dataset ? pendingRows.length : null,
      format: 'count',
      sub:
        dataset && pendingRows.length > 0
          ? t('movements.kpi.pendingAmount', { amount: formatMoney(pendingAmount, { compact: true }) })
          : dataset
            ? t('movements.kpi.pendingNone')
            : null,
    },
  ];

  // ── Columnas ──
  const directionLabel = (d: LedgerDirection) =>
    d === 'deposit' ? t('movements.deposit') : t('movements.withdrawal');
  /** Rechazadas y excluidas: tachadas en `text-3`; internas: atenuadas. */
  const rowTone = (r: LedgerRow) =>
    r.category === 'rejected' || r.category === 'excluded'
      ? 'text-text-3 line-through'
      : r.category === 'internal'
        ? 'text-text-3'
        : undefined;
  const statusCell = (r: LedgerRow) => (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <StatusBadge kind={r.statusKind} label={r.status || '—'} />
      {r.category === 'excluded' && (
        <StatusBadge
          kind="neutral"
          label={t('movements.ledger.cat.excluded')}
          title={t('movements.ledger.excludedTitle', {
            reason: String((r.tx as { excludedReason?: string }).excludedReason ?? '?'),
            by: String((r.tx as { excludedByName?: string }).excludedByName ?? '?'),
          })}
        />
      )}
      {r.category === 'internal' && (
        <StatusBadge kind="neutral" label={t('movements.ledger.cat.internal')} title={t('movements.ledger.internalTitle')} />
      )}
    </span>
  );

  const columns: FinColumn<LedgerRow>[] = [
    {
      key: 'time',
      header: t('movements.ledger.col.time'),
      cell: (r) => <span className={cn('tabular-nums text-text-2', rowTone(r))}>{timeOf(r.at)}</span>,
      hideSm: true,
      width: '64px',
    },
    {
      key: 'client',
      header: t('movements.ledger.col.client'),
      cell: (r) => <span className={rowTone(r)}>{r.client || '—'}</span>,
      meta: (r) => <span className="font-mono text-[12px]">{r.clientId}</span>,
      mobileMeta: (r) => (
        <>
          <span className="tabular-nums">{timeOf(r.at)}</span>
          {statusCell(r)}
        </>
      ),
    },
    {
      key: 'channel',
      header: t('movements.channel'),
      cell: (r) => <span className={rowTone(r)}>{r.channel}</span>,
      meta: (r) => r.wallet,
      hideSm: true,
    },
    {
      key: 'type',
      header: t('movements.type'),
      cell: (r) => <span className={cn('text-text-2', rowTone(r))}>{directionLabel(r.direction)}</span>,
      hideSm: true,
    },
    {
      key: 'status',
      header: t('movements.ledger.col.status'),
      cell: statusCell,
      hideSm: true,
    },
    {
      key: 'amount',
      header: t('movements.amount'),
      kind: 'money',
      value: (r) => signedAmount(r),
      cell: (r) => (
        <Money
          value={signedAmount(r)}
          signed
          tone="neutral"
          className={cn('font-medium', rowTone(r))}
        />
      ),
    },
    {
      key: 'fee',
      header: t('movements.ledger.col.fee'),
      kind: 'money',
      value: (r) => r.fee,
      subtotal: false,
      cell: (r) => <Money value={r.fee} tone="neutral" className={cn('text-text-2', rowTone(r))} />,
      hideSm: true,
    },
  ];

  const groupTotals = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    for (const [day, net] of Object.entries(dayNets)) out[day] = { amount: net };
    return out;
  }, [dayNets]);

  const title = isPaypros ? PROVIDER_META[slug].provider : PROVIDER_META[slug].cardLabel;
  const shownFrom = filtered.length === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const shownTo = Math.min(safePage * PAGE_SIZE, filtered.length);
  const fmtN = (n: number) => kpiPlainText(n, 'count');
  const secondaryBtn =
    'inline-flex h-8 items-center gap-1.5 rounded-ui-md border border-border-strong bg-card px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="space-y-4">
      {Modal2FA}
      <div>
        <Link
          href="/movimientos"
          className="mb-1 inline-flex items-center gap-1 text-[12.5px] text-text-2 hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          {t('movements.title')}
        </Link>
        <PageHeader
          title={title}
          subtitle={
            initialWalletId
              ? t('movements.ledger.subtitleWallet', { wallet: initialWalletId })
              : t('movements.ledger.subtitleAll')
          }
          actions={
            <>
              <button type="button" onClick={load} disabled={loading} className={secondaryBtn} aria-label={t('movements.ledger.refresh')}>
                <RefreshCw aria-hidden className={cn('size-[15px]', loading && 'animate-spin')} strokeWidth={1.75} />
                <span className="hidden sm:inline">{t('movements.ledger.refresh')}</span>
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={!dataset || accepted.length === 0}
                className={secondaryBtn}
                aria-label={t('common.csv')}
              >
                <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
                <span className="hidden sm:inline">{t('common.csv')}</span>
              </button>
            </>
          }
        />
      </div>

      <KpiStrip items={kpis} />

      {errorMsg && (
        <Notice
          kind="bad"
          title={t('movements.ledger.errorTitle')}
          action={
            <button type="button" onClick={load} className={secondaryBtn}>
              {t('movements.notice.retry')}
            </button>
          }
        >
          {errorMsg}
        </Notice>
      )}
      {isStale && (
        <Notice
          kind="stale"
          title={t('movements.ledger.staleTitle', { h: String(Math.round(dataAgeHours ?? 0)) })}
          action={
            <Link href="/movimientos" className="underline underline-offset-2">
              {t('movements.ledger.staleAction')}
            </Link>
          }
        >
          {t('movements.ledger.staleBody')}
        </Notice>
      )}
      {/* Pay-Pros: la exclusión de los payouts del total de DEPÓSITOS se
          AVISA, no se disimula. Se cuentan en Retiros Totales de /movimientos;
          acá se listan con su sentido. Una exclusión silenciosa es
          indistinguible de un cruce roto. */}
      {payprosPayouts.count > 0 && (
        <Notice
          kind="info"
          title={t('movements.ledger.payoutsTitle', {
            n: fmtN(payprosPayouts.count),
            amount: formatMoney(payprosPayouts.total),
          })}
        >
          {t('movements.ledger.payoutsBody')}
        </Notice>
      )}

      <Panel
        title={t('movements.ledger.title')}
        hint={
          dataset
            ? t('movements.ledger.hint', {
                at: formatDateTime(dataset.fetchedAt),
              }) + (dataset.isMock ? ' · mock' : '')
            : undefined
        }
        flush
        actions={
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-text-2">
            <label className="inline-flex items-center gap-1.5">
              {t('movements.rt.from')}
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-auto" />
            </label>
            <label className="inline-flex items-center gap-1.5">
              {t('movements.rt.to')}
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-auto" />
            </label>
            {(from || to) && (
              <button
                type="button"
                onClick={() => {
                  setFrom('');
                  setTo('');
                }}
                className="h-8 rounded-ui-md px-2 font-medium text-text-2 hover:bg-surface-hover hover:text-foreground"
              >
                {t('movements.ledger.clear')}
              </button>
            )}
          </div>
        }
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* El recorte SIEMPRE contado (reglas §1.2). */}
            <p>
              {t('movements.ledger.showing', {
                from: fmtN(shownFrom),
                to: fmtN(shownTo),
                total: fmtN(filtered.length),
                counted: fmtN(countingAll),
              })}
            </p>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage(Math.max(1, safePage - 1))}
                  disabled={safePage === 1}
                  className={cn(secondaryBtn, 'w-8 justify-center px-0')}
                  aria-label={t('movements.ledger.prev')}
                >
                  <ChevronLeft aria-hidden className="size-4" />
                </button>
                <span className="tabular-nums">
                  {t('movements.ledger.page', { n: String(safePage), m: String(totalPages) })}
                </span>
                <button
                  type="button"
                  onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                  disabled={safePage === totalPages}
                  className={cn(secondaryBtn, 'w-8 justify-center px-0')}
                  aria-label={t('movements.ledger.next')}
                >
                  <ChevronRight aria-hidden className="size-4" />
                </button>
              </div>
            )}
          </div>
        }
      >
        {/* Filtros: sentido, categoría y búsqueda. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          {hasBothDirections && (
            <Segmented<'all' | LedgerDirection>
              aria-label={t('movements.ledger.directionAria')}
              value={direction}
              onChange={(v) => {
                setDirection(v);
                setPage(1);
              }}
              options={[
                { value: 'all', label: t('movements.ledger.all'), count: counts.all },
                { value: 'deposit', label: t('movements.depositsTab'), count: counts.deposit },
                { value: 'withdrawal', label: t('movements.withdrawalsTab'), count: counts.withdrawal },
              ]}
            />
          )}
          {CATEGORY_ORDER.filter((c) => chipCounts[c] > 0).map((c) => (
            <Chip
              key={c}
              active={categories.includes(c)}
              count={chipCounts[c]}
              onClick={() => toggleCategory(c)}
            >
              {t(`movements.ledger.cat.${c}`)}
            </Chip>
          ))}
          <div className="relative ml-auto flex min-w-[220px] max-w-[320px] flex-1 items-center max-sm:max-w-none">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 size-[15px] text-text-3" />
            <Input
              type="search"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              placeholder={t('movements.ledger.searchPlaceholder')}
              aria-label={t('movements.ledger.searchPlaceholder')}
              className="pl-8 pr-8"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 inline-flex size-6 items-center justify-center rounded-ui-sm text-text-3 hover:text-foreground"
                aria-label={t('movements.ledger.clearSearch')}
              >
                <X aria-hidden className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        <FinTable
          caption={t('movements.ledger.title')}
          columns={columns}
          rows={pageRows}
          rowKey={(r) => `${r.slug}:${r.id}`}
          groupBy={(r) => dayKey(r.at)}
          groupLabel={(day) => (day === 'sin-fecha' ? t('movements.ledger.noDate') : formatDateRelative(day))}
          groupTotals={groupTotals}
          rowActions={
            supportsExclusion
              ? (r) => (
                  <ExcludeToggleButton
                    tx={r.tx as CoinsbuyDepositTx | CoinsbuyWithdrawalTx}
                    provider={slug}
                    onChange={load}
                  />
                )
              : undefined
          }
          footer={
            filtered.length > 0
              ? {
                  label: t('movements.ledger.footer', { n: fmtN(filteredCounting) }),
                  values: { amount: filteredNet },
                }
              : undefined
          }
          maxHeight="70vh"
          empty={loading ? t('movements.rt.loading') : t('movements.ledger.empty')}
        />
      </Panel>
    </div>
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
    case 'paypros': {
      const r = rows as PayprosDepositTx[];
      return {
        headers: ['Fecha', 'ID', 'Referencia', 'Monto', 'Moneda', 'Estado'],
        rows: r.map((t) => [
          t.createdAt,
          t.id,
          t.notifyReference,
          t.amount,
          t.currency,
          t.status,
        ]),
      };
    }
  }
}
