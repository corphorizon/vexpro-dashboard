'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /egresos — consulta de egresos del período.
//
// Pantalla de SOLO CONSULTA: toda la edición de egresos (crear, editar, marcar
// pagado, eliminar, propagar egresos fijos, adjuntar comprobante) vive en
// «Carga de Datos» (/upload), detrás del guard de huella del 2026-10-08
// (lib/expenses/huella-periodo.ts — la pestaña vieja que pisó el período).
// Esta pantalla NO escribe: no hay ninguna ruta acá que pueda pisar egresos.
// Los egresos que nacen de una orden de pago se linkean a su OP (concepto y
// acción de fila) y heredan referencia y comprobante.
//
// «Libro mayor» (2026-10-12, docs/diseno-libro-mayor.md):
//   · KpiStrip (Total hero, Pagados, Pendientes, Fijos) en vez de tres
//     StatCard con íconos de color. «Fijos» es nuevo y es «—» si no sabemos
//     qué es fijo (expenses-view.ts → fixedSummary).
//   · Segmented por estado con conteos — ahora con «Parcial», que la tabla no
//     distinguía y el PDF de cierre sí (el estado sale de `expenseStatus`, el
//     mismo del PDF, y el color de statusKind('expense', …)).
//   · Chips por categoría y FinTable AGRUPADA por categoría con subtotales, en
//     el orden del reporte de empresa (buildExpenses). Referencia y
//     descripción de la OP como metadato bajo el concepto; comprobante y OP
//     como acciones de fila.
//   · Recorte contado: cuando búsqueda/estado/categoría dejan afuera filas, el
//     pie del total lo dice con números («Total filtrado · 12 de 40»). Un
//     filtro olvidado se veía igual que «el mes tiene 12 egresos».
//
// Medición (colores fuera de tokens en este archivo, sin contar comentarios):
// antes 7 clases de paleta cruda (`text-white`, `bg-slate-100`,
// `text-slate-700`, `border-slate-200` y 3 más bajo `dark:`), 4 `dark:` de
// color, 1 `text-[11px]`, 3 `[var(--color-primary)]` y 32 tokens legados
// (`text-muted-foreground`, `bg-muted`, `bg-info/10`); después 0 en todo.
//
// DESCARTADO:
//   · Pasar la moneda de la empresa a <Money>: antes de la migración esta
//     pantalla formateaba en USD (formatCurrency sin moneda). Cambiarlo es un
//     cambio de número, no de diseño — queda anotado para decidirlo aparte.
//   · Quitar el selector de período del contenido (spec §6.2): las demás
//     pantallas migradas lo conservan hasta que la topbar lo absorba.
// ─────────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown, Download, ExternalLink, Receipt, Search, X } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { Segmented } from '@/components/ui/segmented';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { NUM_CLASS } from '@/components/ui/money';
import { StatusBadge, statusKind } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ConsolidatedBadge } from '@/components/ui/consolidated-badge';
import { ExpenseConcept } from '@/components/ui/expense-concept';
import { ROW_ACTION_CLASS, actionButtonClass } from '@/components/payment-orders/action-button';
import { PeriodSelector } from '@/components/period-selector';
import { NoPeriodsState } from '@/components/no-periods-state';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { usePeriod } from '@/lib/period-context';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { useAutoClearMessage } from '@/lib/use-auto-clear-message';
import { downloadCSV } from '@/lib/csv-export';
import { formatDate, formatDayMonth } from '@/lib/dates';
import { cn } from '@/lib/utils';
import type { ExpenseStatus } from '@/lib/monthly-close-pdf-data';
import type { Expense, PreoperativeExpense } from '@/lib/types';
import { AttachmentButton } from './attachment-button';
import {
  EXPENSE_FILTERS,
  UNCATEGORIZED,
  applySearchAndCategories,
  categoryChips,
  categoryKey,
  expenseTotals,
  fixedSummary,
  groupedExpenseRows,
  rowStatus,
  statusCounts,
  type ExpenseFilter,
  type SortState,
} from './expenses-view';

/** Clave i18n de cada estado. `Record` sobre ExpenseStatus: un estado nuevo sin etiqueta no compila. */
const STATUS_LABEL_KEY: Record<ExpenseStatus, string> = {
  pagado: 'expenses.paidStatus',
  pendiente: 'expenses.pendingStatus',
  parcial: 'expenses.partialStatus',
};

const FILTER_LABEL_KEY: Record<ExpenseFilter, string> = {
  all: 'expenses.filterAll',
  pagado: 'expenses.filterPaid',
  pendiente: 'expenses.filterPending',
  parcial: 'expenses.filterPartial',
};

/** Chips de categoría visibles; el resto se cuenta («+3 más: usá el buscador»). */
const MAX_CATEGORY_CHIPS = 8;

const SortIcon = ({ state }: { state: SortState }) => {
  if (state === 'desc') return <ArrowDown aria-hidden className="size-[15px]" strokeWidth={1.75} />;
  if (state === 'asc') return <ArrowUp aria-hidden className="size-[15px]" strokeWidth={1.75} />;
  return <ArrowUpDown aria-hidden className="size-[15px]" strokeWidth={1.75} />;
};

function isUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export default function EgresosPage() {
  const { t } = useI18n();
  const { mode, selectedPeriodId, selectedPeriodIds } = usePeriod();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const { getPeriodSummary, getConsolidatedSummary, preoperativeExpenses, periods, loading } = useData();

  const [showPreoperativo, setShowPreoperativo] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<ExpenseFilter>('all');
  const [categories, setCategories] = useState<string[]>([]);
  const [sortState, setSortState] = useState<SortState>('default');
  const [errorMsg, showError] = useAutoClearMessage(4500);

  const summary =
    mode === 'consolidated' ? getConsolidatedSummary(selectedPeriodIds) : getPeriodSummary(selectedPeriodId);

  const currentExpenses = useMemo<Expense[]>(() => summary?.expenses ?? [], [summary]);

  // ── Filtros: búsqueda + categorías → conteos por estado → estado ──────────
  const searched = useMemo(
    () => applySearchAndCategories(currentExpenses, query, categories),
    [currentExpenses, query, categories],
  );
  const counts = useMemo(() => statusCounts(searched), [searched]);
  const rows = useMemo(
    () => groupedExpenseRows(currentExpenses, { status: statusFilter, query, categories }, sortState),
    [currentExpenses, statusFilter, query, categories, sortState],
  );
  // Los chips cuentan sobre búsqueda + estado (sin los propios chips): el
  // número dice cuántas filas suma el chip si lo prendés.
  const chipBase = useMemo(() => {
    const base = applySearchAndCategories(currentExpenses, query, []);
    return statusFilter === 'all' ? base : base.filter((e) => rowStatus(e) === statusFilter);
  }, [currentExpenses, query, statusFilter]);
  // La lista de categorías sale de TODO el período (no salta al filtrar).
  const allChips = useMemo(() => categoryChips(currentExpenses), [currentExpenses]);
  const chipN = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of chipBase) m.set(categoryKey(e), (m.get(categoryKey(e)) ?? 0) + 1);
    return m;
  }, [chipBase]);
  const visibleChips = useMemo(() => {
    const top = allChips.slice(0, MAX_CATEGORY_CHIPS);
    // Un chip activo nunca desaparece de la vista aunque quede fuera del top.
    const extra = allChips.slice(MAX_CATEGORY_CHIPS).filter((c) => categories.includes(c.key));
    return [...top, ...extra];
  }, [allChips, categories]);
  const hiddenChips = allChips.length - visibleChips.length;

  const periodCounts = useMemo(() => statusCounts(currentExpenses), [currentExpenses]);
  const fixed = useMemo(() => fixedSummary(currentExpenses), [currentExpenses]);
  const rowTotals = useMemo(() => expenseTotals(rows), [rows]);

  const preopTotals = useMemo(
    () => expenseTotals(preoperativeExpenses.map((e) => ({ ...e, category: null }))),
    [preoperativeExpenses],
  );

  const categoryLabel = (key: string) => (key === UNCATEGORIZED ? t('expenses.uncategorized') : key);

  const cycleSortState = () => {
    setSortState((prev) => (prev === 'default' ? 'desc' : prev === 'desc' ? 'asc' : 'default'));
  };

  function toggleCategory(key: string) {
    setCategories((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  const exportCsv = () =>
    verify2FA(() => {
      if (showPreoperativo) {
        const headers = ['#', t('expenses.concept'), t('expenses.amount'), t('expenses.paid'), t('expenses.pending')];
        const data = preoperativeExpenses.map(
          (e, i) => [i + 1, e.concept, e.amount, e.paid, e.pending] as (string | number)[],
        );
        downloadCSV(`egresos_${(summary?.period.label || 'export').replace(/\s/g, '_')}.csv`, headers, data);
        return;
      }
      const headers = [
        '#',
        t('expenses.concept'),
        'Descripción OP',
        'Categoría',
        t('expenses.date'),
        t('expenses.amount'),
        t('expenses.paid'),
        t('expenses.pending'),
      ];
      // El CSV exporta lo que la tabla muestra, en el mismo orden. La fecha va
      // completa (DD/MM/AAAA): fuera de la tabla no hay período que dé el año.
      const data = rows.map(
        (e, i) =>
          [
            i + 1,
            e.concept,
            e.payment_order_description ?? '',
            e.category ?? '',
            e.expense_date ? formatDate(e.expense_date) : '',
            e.amount,
            e.paid,
            e.pending,
          ] as (string | number)[],
      );
      downloadCSV(`egresos_${(summary?.period.label || 'export').replace(/\s/g, '_')}.csv`, headers, data);
    });

  // Sin períodos no hay nada que cargar: un esqueleto eterno haría creer
  // que el sistema está trabajando.
  if (!loading && periods.length === 0) return <NoPeriodsState />;

  if (!summary) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-[92px]" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const n = (x: number) => String(x);
  const kpiItems: KpiItem[] = [
    {
      key: 'total',
      label: mode === 'consolidated' ? t('expenses.kpiTotalRange') : t('expenses.kpiTotal'),
      value: summary.totalExpenses,
      hero: true,
      sub: t('expenses.kpiCount', { count: n(periodCounts.all) }),
    },
    {
      key: 'paid',
      label: t('expenses.kpiPaid'),
      value: summary.totalExpensesPaid,
      sub: t('expenses.kpiPaidHint', { count: n(periodCounts.pagado) }),
    },
    {
      key: 'pending',
      label: t('expenses.kpiPending'),
      value: summary.totalExpensesPending,
      sub:
        periodCounts.parcial > 0
          ? t('expenses.kpiPendingHintPartial', {
              count: n(periodCounts.pendiente),
              partial: n(periodCounts.parcial),
            })
          : t('expenses.kpiPendingHint', { count: n(periodCounts.pendiente) }),
    },
    {
      key: 'fixed',
      label: t('expenses.kpiFixed'),
      value: fixed.sum,
      sub: fixed.sum === null ? t('expenses.kpiFixedUnknown') : t('expenses.kpiFixedHint', { count: n(fixed.count) }),
      missingBadge: false,
    },
  ];

  // ── Columnas ──────────────────────────────────────────────────────────────
  const statusBadge = (e: Pick<Expense, 'amount' | 'paid' | 'pending'>) => {
    const s = rowStatus(e);
    return <StatusBadge kind={statusKind('expense', s)} label={t(STATUS_LABEL_KEY[s])} />;
  };
  const dateText = (e: Expense) => (e.expense_date ? formatDayMonth(e.expense_date) : '—');

  const conceptMeta = (e: Expense) => {
    const ref = e.reference?.trim();
    const desc = e.payment_order_description?.trim();
    if (!ref && !desc && !e.is_fixed) return null;
    return (
      <>
        {e.is_fixed && <span className="text-text-2">{t('expenses.fixedBadge')}</span>}
        {e.is_fixed && (desc || ref) && ' · '}
        {desc}
        {desc && ref && ' · '}
        {ref &&
          (isUrl(ref) ? (
            <a
              href={ref}
              target="_blank"
              rel="noopener noreferrer"
              title={ref}
              onClick={(ev) => ev.stopPropagation()}
              className="text-info hover:underline"
            >
              {ref}
            </a>
          ) : (
            <span title={ref} className="font-mono">
              {ref}
            </span>
          ))}
      </>
    );
  };

  const columns: FinColumn<Expense>[] = [
    {
      key: 'concept',
      header: t('expenses.concept'),
      cell: (e) => <ExpenseConcept concept={e.concept} paymentOrderId={e.payment_order_id} />,
      meta: conceptMeta,
      mobileMeta: (e) => (
        <>
          {statusBadge(e)}
          <span className={NUM_CLASS}>{dateText(e)}</span>
        </>
      ),
    },
    {
      key: 'category',
      header: t('expenses.category'),
      hideSm: true,
      cell: (e) => <span className="text-text-2">{categoryLabel(categoryKey(e))}</span>,
    },
    {
      key: 'status',
      header: t('expenses.status'),
      hideSm: true,
      cell: statusBadge,
    },
    {
      key: 'date',
      header: t('expenses.date'),
      hideSm: true,
      width: '72px',
      cell: (e) => <span className={cn(NUM_CLASS, 'text-text-2')}>{dateText(e)}</span>,
    },
    { key: 'amount', header: t('expenses.amount'), kind: 'money', value: (e) => e.amount },
    { key: 'paid', header: t('expenses.paid'), kind: 'money', value: (e) => e.paid, hideSm: true },
    { key: 'pending', header: t('expenses.pending'), kind: 'money', value: (e) => e.pending, hideSm: true },
  ];

  const rowActions = (e: Expense) => (
    <>
      {e.payment_order_id && (
        <Link
          href={`/ordenes-pago/${e.payment_order_id}`}
          className={ROW_ACTION_CLASS}
          title={t('expenses.viewOrder')}
          aria-label={`${t('expenses.viewOrder')}: ${e.concept}`}
        >
          <ExternalLink aria-hidden className="size-4" strokeWidth={1.75} />
        </Link>
      )}
      {e.attachment_path && (
        <AttachmentButton expenseId={e.id} name={e.attachment_name} onError={showError} />
      )}
    </>
  );

  const filtered = rows.length < currentExpenses.length;
  const footerLabel = filtered
    ? t('expenses.footerFiltered', { shown: n(rows.length), total: n(currentExpenses.length) })
    : t('expenses.footerTotal', { count: n(rows.length) });

  const preopColumns: FinColumn<PreoperativeExpense>[] = [
    {
      key: 'concept',
      header: t('expenses.concept'),
      cell: (e) => e.concept,
      mobileMeta: (e) => statusBadge(e),
    },
    { key: 'status', header: t('expenses.status'), hideSm: true, cell: statusBadge },
    { key: 'amount', header: t('expenses.amount'), kind: 'money', value: (e) => e.amount },
    { key: 'paid', header: t('expenses.paid'), kind: 'money', value: (e) => e.paid, hideSm: true },
    { key: 'pending', header: t('expenses.pending'), kind: 'money', value: (e) => e.pending, hideSm: true },
  ];

  const hasFilters = query.trim() !== '' || statusFilter !== 'all' || categories.length > 0;
  const clearFilters = () => {
    setQuery('');
    setStatusFilter('all');
    setCategories([]);
  };

  return (
    <div className="space-y-4">
      {Modal2FA}
      <PageHeader
        title={t('expenses.title')}
        subtitle={t('expenses.subtitle')}
        icon={Receipt}
        actions={
          <>
            <ConsolidatedBadge count={mode === 'consolidated' ? selectedPeriodIds.length : 1} />
            <button
              type="button"
              aria-pressed={showPreoperativo}
              onClick={() => setShowPreoperativo((v) => !v)}
              className={actionButtonClass(
                'secondary',
                showPreoperativo ? 'border-brand-ink bg-brand-tint font-semibold text-brand-ink hover:bg-brand-tint' : undefined,
              )}
            >
              {t('expenses.preoperative')}
            </button>
            <button
              type="button"
              onClick={exportCsv}
              className={actionButtonClass('secondary')}
              title={t('common.csv')}
              aria-label={t('common.csv')}
            >
              <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t('common.csv')}</span>
            </button>
            <PeriodSelector />
          </>
        }
      />

      {errorMsg && <Notice kind="bad" title={errorMsg} />}

      {showPreoperativo ? (
        <Panel flush title={t('expenses.preoperative')} hint={t('expenses.preoperativeHint')}>
          <FinTable
            caption={t('expenses.preoperative')}
            columns={preopColumns}
            rows={preoperativeExpenses}
            rowKey={(e) => e.id}
            maxHeight="65vh"
            footer={
              preoperativeExpenses.length > 0
                ? {
                    label: t('expenses.footerTotal', { count: n(preoperativeExpenses.length) }),
                    values: { amount: preopTotals.amount, paid: preopTotals.paid, pending: preopTotals.pending },
                  }
                : undefined
            }
            empty={t('expenses.noExpenses')}
          />
        </Panel>
      ) : (
        <>
          <KpiStrip items={kpiItems} />

          <Panel
            flush
            title={t('expenses.detail')}
            hint={summary.period.label ?? undefined}
            footer={t('expenses.readOnlyNote')}
          >
            {/* Estado + búsqueda + orden */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <div className="max-w-full overflow-x-auto">
                <Segmented<ExpenseFilter>
                  aria-label={t('expenses.statusFilterAria')}
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={EXPENSE_FILTERS.map((f) => ({ value: f, label: t(FILTER_LABEL_KEY[f]), count: counts[f] }))}
                />
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2 max-sm:w-full">
                <div className="relative flex min-w-[220px] max-w-[320px] flex-1 items-center max-sm:max-w-none">
                  <Search aria-hidden className="pointer-events-none absolute left-2.5 size-[15px] text-text-3" />
                  <Input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('expenses.search')}
                    aria-label={t('expenses.search')}
                    className="pl-8 pr-8"
                  />
                  {query && (
                    <button
                      type="button"
                      onClick={() => setQuery('')}
                      className="absolute right-1.5 inline-flex size-6 items-center justify-center rounded-ui-sm text-text-3 hover:text-foreground"
                      aria-label={t('expenses.clearSearch')}
                    >
                      <X aria-hidden className="size-3.5" />
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={cycleSortState}
                  aria-pressed={sortState !== 'default'}
                  className={actionButtonClass(
                    'secondary',
                    sortState !== 'default' ? 'border-brand-ink bg-brand-tint text-brand-ink hover:bg-brand-tint' : undefined,
                  )}
                  title={
                    sortState === 'default'
                      ? t('expenses.sortDefault')
                      : sortState === 'desc'
                        ? t('expenses.sortDesc')
                        : t('expenses.sortAsc')
                  }
                >
                  <SortIcon state={sortState} />
                  {t('expenses.sortAmount')}
                  {sortState !== 'default' && (
                    <span className="text-text-3">
                      {sortState === 'desc' ? t('expenses.sortHighest') : t('expenses.sortLowest')}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* Chips por categoría */}
            {allChips.length > 1 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                {visibleChips.map((c) => (
                  <Chip
                    key={c.key}
                    active={categories.includes(c.key)}
                    count={chipN.get(c.key) ?? 0}
                    onClick={() => toggleCategory(c.key)}
                    className="max-w-[220px]"
                  >
                    <span className="truncate">{categoryLabel(c.key)}</span>
                  </Chip>
                ))}
                {hiddenChips > 0 && (
                  <span className="text-[12.5px] text-text-3">
                    {t('expenses.moreCategories', { count: n(hiddenChips) })}
                  </span>
                )}
              </div>
            )}

            <FinTable
              caption={t('expenses.detail')}
              columns={columns}
              rows={rows}
              rowKey={(e) => e.id}
              groupBy={categoryKey}
              groupLabel={categoryLabel}
              rowActions={rowActions}
              maxHeight="65vh"
              footer={
                rows.length > 0
                  ? {
                      label: footerLabel,
                      values: { amount: rowTotals.amount, paid: rowTotals.paid, pending: rowTotals.pending },
                    }
                  : undefined
              }
              empty={
                hasFilters ? (
                  <EmptyState
                    compact
                    icon={Search}
                    title={t('expenses.noResults')}
                    action={
                      <button type="button" onClick={clearFilters} className={actionButtonClass('secondary')}>
                        {t('expenses.clearFilters')}
                      </button>
                    }
                  />
                ) : (
                  <EmptyState compact icon={Receipt} title={t('expenses.noExpenses')} />
                )
              }
            />
          </Panel>
        </>
      )}
    </div>
  );
}
