'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /ingresos — consulta de ingresos operativos.
//
// Espejo exacto de /egresos: SOLO LECTURA. El detalle por concepto se carga en
// "Carga de Datos" (pestaña Ingresos) y hasta hoy no había dónde MIRARLO — el
// único acceso era la pantalla de edición, que obliga a entrar a un formulario
// para responder "¿cuánto facturamos y cuánto nos deben este mes?".
//
// La cifra destacada es "Por cobrar", no lo facturado: lo que se reparte en la
// cadena de socios es lo COBRADO (ver src/lib/income-lines.ts), así que la
// pregunta que la pantalla tiene que contestar de un vistazo es cuánta plata
// facturada todavía no entró.
//
// Aplica a los dos modelos de negocio: `incomeLines` está en true tanto para
// broker como para company (src/lib/business-model.ts).
//
// «Libro mayor» (2026-10-12, docs/diseno-libro-mayor.md):
//   · KpiStrip (Facturado, Cobrado, Por cobrar hero, Clientes) en vez de tres
//     StatCard. Los KPIs miran el período entero; la tabla y su pie, lo que
//     deja la búsqueda — y el pie lo dice con números cuando filtra.
//   · Panel «Facturación por cliente» como en el PDF de cierre de empresa de
//     servicios: sale de buildBilling (income-view.ts), la misma función del
//     PDF. Quien más debe primero.
//   · FinTable de líneas: concepto con cliente/categoría/referencia como
//     metadato, Facturado/Cobrado/Por cobrar con <Money>, estado con
//     «Parcial» (antes una factura cobrada a medias se veía «Por cobrar»).
//   · Error de carga como Notice `bad` (antes un EmptyState sin color).
//
// Medición (colores fuera de tokens, sin contar comentarios): antes 0 paleta
// cruda, 1 `dark:` de color, 1 `text-[11px]`, 1 `[var(--color-primary)]` y 26
// tokens legados (`text-muted-foreground`, `bg-muted`, `bg-info/10`); después 0.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Search, TrendingUp, X } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { NUM_CLASS } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ConsolidatedBadge } from '@/components/ui/consolidated-badge';
import { actionButtonClass } from '@/components/ui/action-button';
import { PeriodSelector } from '@/components/period-selector';
import { NoPeriodsState } from '@/components/no-periods-state';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { usePeriod } from '@/lib/period-context';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { downloadCSV } from '@/lib/csv-export';
import { formatDate, formatDayMonth } from '@/lib/dates';
import { computeIncomeTotals, type IncomeLine } from '@/lib/income-lines';
import { UNASSIGNED_CLIENT_KEY } from '@/lib/clients';
import type { BillingClientRow } from '@/lib/reports/company-report';
import { cn, periodLabel } from '@/lib/utils';
import {
  INCOME_STATUS_KIND,
  billingByClient,
  filterIncomeLines,
  incomeLineStatus,
  type IncomeLineStatus,
  type SortState,
} from './income-view';

const STATUS_LABEL_KEY: Record<IncomeLineStatus, string> = {
  collected: 'income.collectedStatus',
  partial: 'income.partialStatus',
  pending: 'income.pendingStatus',
};

const SortIcon = ({ state }: { state: SortState }) => {
  if (state === 'desc') return <ArrowDown aria-hidden className="size-[15px]" strokeWidth={1.75} />;
  if (state === 'asc') return <ArrowUp aria-hidden className="size-[15px]" strokeWidth={1.75} />;
  return <ArrowUpDown aria-hidden className="size-[15px]" strokeWidth={1.75} />;
};

export default function IngresosPage() {
  const { t } = useI18n();
  const { mode, selectedPeriodId, selectedPeriodIds } = usePeriod();
  const { user } = useAuth();
  const { company, periods, loading: dataLoading } = useData();
  const canView = useModuleAccess('income');
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);

  const [searchQuery, setSearchQuery] = useState('');
  const [sortState, setSortState] = useState<SortState>('default');

  // En consolidado los ids cambian de identidad en cada render aunque el
  // contenido sea el mismo; sin esta clave el efecto refetchearía en bucle.
  const requestKey =
    mode === 'consolidated' ? `c:${selectedPeriodIds.join(',')}` : `s:${selectedPeriodId}`;

  // La respuesta se guarda junto a la clave que la pidió. Así "cargando" es
  // una comparación derivada (clave pedida ≠ clave respondida) y el efecto no
  // necesita un setState sincrónico que dispare un render en cascada.
  const [result, setResult] = useState<{
    key: string;
    lines: IncomeLine[];
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!canView) return;
    if (mode !== 'consolidated' && !selectedPeriodId) return;
    // Un solo período pide solo ese; el consolidado trae el histórico y filtra
    // acá, porque el endpoint acepta un `period_id`, no una lista.
    const url =
      mode === 'consolidated'
        ? '/api/admin/income-lines'
        : `/api/admin/income-lines?period_id=${encodeURIComponent(selectedPeriodId)}`;

    let alive = true;
    apiFetch(url)
      .then((res) => res.json())
      .then((json: { success?: boolean; lines?: IncomeLine[] }) => {
        if (!alive) return;
        if (json?.success) setResult({ key: requestKey, lines: json.lines ?? [], failed: false });
        else setResult({ key: requestKey, lines: [], failed: true });
      })
      .catch(() => {
        if (alive) setResult({ key: requestKey, lines: [], failed: true });
      });
    return () => {
      alive = false;
    };
  }, [canView, mode, selectedPeriodId, requestKey]);

  const loading = result?.key !== requestKey;
  const failed = !loading && !!result?.failed;
  const lines = useMemo(() => (result?.key === requestKey ? result.lines : []), [result, requestKey]);

  const currency = company?.currency || 'USD';

  const periodMeta = useMemo(
    () => periods.map((p) => ({ id: p.id, year: p.year, month: p.month, label: p.label || periodLabel(p.year, p.month) })),
    [periods],
  );
  const periodLabels = useMemo(() => new Map(periodMeta.map((p) => [p.id, p.label])), [periodMeta]);

  // El consolidado recorta al conjunto elegido; el modo simple ya vino filtrado
  // por el endpoint, pero se re-filtra igual para que una respuesta vieja en
  // vuelo no pinte líneas de otro mes.
  const scopedLines = useMemo(() => {
    const allowed = new Set(mode === 'consolidated' ? selectedPeriodIds : [selectedPeriodId]);
    return lines.filter((l) => allowed.has(l.period_id));
  }, [lines, mode, selectedPeriodIds, selectedPeriodId]);

  const visibleLines = useMemo(
    () => filterIncomeLines(scopedLines, searchQuery, sortState),
    [scopedLines, searchQuery, sortState],
  );

  // Los KPIs y la facturación por cliente miran el período completo; la tabla
  // de líneas y su pie, lo filtrado.
  const scopedTotals = useMemo(() => computeIncomeTotals(scopedLines), [scopedLines]);
  const visibleTotals = useMemo(() => computeIncomeTotals(visibleLines), [visibleLines]);
  const billing = useMemo(() => billingByClient(scopedLines, periodMeta), [scopedLines, periodMeta]);
  const openLines = useMemo(
    () => scopedLines.filter((l) => incomeLineStatus(l) !== 'collected').length,
    [scopedLines],
  );

  const cycleSortState = () => {
    setSortState((prev) => (prev === 'default' ? 'desc' : prev === 'desc' ? 'asc' : 'default'));
  };

  const scopeLabel =
    mode === 'consolidated'
      ? t('income.consolidatedScope', { count: String(selectedPeriodIds.length) })
      : periodLabels.get(selectedPeriodId) ?? '—';

  const exportCSV = () => {
    verify2FA(() => {
      const headers = [
        '#',
        t('income.period'),
        t('income.concept'),
        t('income.client'),
        t('income.category'),
        t('expenses.date'),
        t('income.invoiced'),
        t('income.received'),
        t('income.pendingAmount'),
      ];
      const rows = visibleLines.map(
        (l, i) =>
          [
            i + 1,
            periodLabels.get(l.period_id) ?? '',
            l.concept,
            l.client ?? '',
            l.category ?? '',
            // Fecha completa en el CSV: fuera de la tabla no hay período que
            // dé el año por contexto.
            l.income_date ? formatDate(l.income_date) : '',
            l.amount,
            l.received,
            l.pending,
          ] as (string | number)[],
      );
      downloadCSV(`ingresos_${scopeLabel.replace(/\s/g, '_')}.csv`, headers, rows);
    });
  };

  if (!canView) {
    return <EmptyState icon={TrendingUp} title={t('income.title')} description={t('common.noAccess')} />;
  }

  // Sin períodos no hay nada que cargar: un esqueleto eterno haría creer que
  // el sistema está trabajando.
  if (!dataLoading && periods.length === 0) return <NoPeriodsState />;

  const n = (x: number) => String(x);
  const clientName = (key: string, name: string) =>
    key === UNASSIGNED_CLIENT_KEY || !name ? t('income.unassignedClient') : name;

  const kpiItems: KpiItem[] = [
    {
      key: 'invoiced',
      label: t('income.invoiced'),
      value: scopedTotals.amount,
      currency,
      sub: t('income.kpiLines', { count: n(scopedLines.length) }),
    },
    {
      key: 'received',
      label: t('income.received'),
      value: scopedTotals.received,
      currency,
      sub: t('income.kpiReceivedHint'),
    },
    {
      // La cifra que se mira para cobrar va destacada.
      key: 'pending',
      label: t('income.pendingAmount'),
      value: scopedTotals.pending,
      currency,
      hero: true,
      sub: t('income.kpiPendingHint', { count: n(openLines) }),
    },
    {
      key: 'clients',
      label: t('income.kpiClients'),
      value: billing.clientCount,
      format: 'count',
      sub: t('income.kpiClientsHint', { count: n(billing.withDebt) }),
    },
  ];

  const statusBadge = (l: IncomeLine) => {
    const s = incomeLineStatus(l);
    return <StatusBadge kind={INCOME_STATUS_KIND[s]} label={t(STATUS_LABEL_KEY[s])} />;
  };
  const dateText = (l: IncomeLine) => (l.income_date ? formatDayMonth(l.income_date) : '—');

  const lineColumns: FinColumn<IncomeLine>[] = [
    // En consolidado hay varios meses mezclados: sin esta columna dos facturas
    // iguales de meses distintos se ven como un duplicado.
    ...(mode === 'consolidated'
      ? [
          {
            key: 'period',
            header: t('income.period'),
            hideSm: true,
            cell: (l: IncomeLine) => (
              <span className="whitespace-nowrap text-text-2">{periodLabels.get(l.period_id) ?? '—'}</span>
            ),
          },
        ]
      : []),
    {
      key: 'concept',
      header: t('income.concept'),
      cell: (l) => l.concept,
      meta: (l) => [l.category?.trim(), l.reference?.trim()].filter(Boolean).join(' · ') || null,
      mobileMeta: (l) => (
        <>
          {statusBadge(l)}
          <span>{l.client?.trim() || t('income.unassignedClient')}</span>
          {mode === 'consolidated' && <span>{periodLabels.get(l.period_id) ?? '—'}</span>}
        </>
      ),
    },
    {
      key: 'client',
      header: t('income.client'),
      hideSm: true,
      cell: (l) =>
        l.client?.trim() ? (
          <span className="text-foreground">{l.client}</span>
        ) : (
          <span className="text-text-3">{t('income.unassignedClient')}</span>
        ),
    },
    {
      key: 'date',
      header: t('expenses.date'),
      hideSm: true,
      width: '72px',
      cell: (l) => <span className={cn(NUM_CLASS, 'text-text-2')}>{dateText(l)}</span>,
    },
    { key: 'status', header: t('expenses.status'), hideSm: true, cell: statusBadge },
    { key: 'amount', header: t('income.invoiced'), kind: 'money', value: (l) => l.amount, money: { currency } },
    {
      key: 'received',
      header: t('income.received'),
      kind: 'money',
      value: (l) => l.received,
      money: { currency },
      hideSm: true,
    },
    {
      key: 'pending',
      header: t('income.pendingAmount'),
      kind: 'money',
      value: (l) => l.pending,
      money: { currency },
      hideSm: true,
    },
  ];

  const clientColumns: FinColumn<BillingClientRow>[] = [
    {
      key: 'client',
      header: t('income.client'),
      cell: (c) =>
        c.key === UNASSIGNED_CLIENT_KEY ? (
          <span className="text-text-3">{clientName(c.key, c.name)}</span>
        ) : (
          clientName(c.key, c.name)
        ),
      mobileMeta: (c) => {
        const s = incomeLineStatus({ received: c.collected, pending: c.pending });
        return <StatusBadge kind={INCOME_STATUS_KIND[s]} label={t(STATUS_LABEL_KEY[s])} />;
      },
    },
    { key: 'billed', header: t('income.invoiced'), kind: 'money', value: (c) => c.billed, money: { currency }, hideSm: true },
    {
      key: 'collected',
      header: t('income.received'),
      kind: 'money',
      value: (c) => c.collected,
      money: { currency },
      hideSm: true,
    },
    { key: 'pending', header: t('income.pendingAmount'), kind: 'money', value: (c) => c.pending, money: { currency } },
  ];

  const filtered = visibleLines.length < scopedLines.length;
  const lineFooterLabel = filtered
    ? t('income.footerFiltered', { shown: n(visibleLines.length), total: n(scopedLines.length) })
    : t('income.footerTotal', { count: n(visibleLines.length) });

  return (
    <div className="space-y-4">
      {Modal2FA}
      <PageHeader
        title={t('income.title')}
        subtitle={t('income.subtitle')}
        icon={TrendingUp}
        actions={
          <>
            <ConsolidatedBadge count={mode === 'consolidated' ? selectedPeriodIds.length : 1} />
            <button
              type="button"
              onClick={exportCSV}
              disabled={visibleLines.length === 0}
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

      {loading ? (
        <div className="space-y-4" aria-busy="true">
          <Skeleton className="h-[92px]" />
          <Skeleton className="h-48" />
          <Skeleton className="h-72" />
        </div>
      ) : failed ? (
        <Notice kind="bad" title={t('income.fetchError')} />
      ) : (
        <>
          <KpiStrip items={kpiItems} />

          {/* Facturación por cliente — la del PDF de cierre (buildBilling). */}
          {billing.clients.length > 0 && (
            <Panel
              flush
              title={t('income.byClient')}
              hint={t('income.byClientHint', { count: n(billing.clientCount), debt: n(billing.withDebt) })}
            >
              <FinTable
                caption={t('income.byClient')}
                columns={clientColumns}
                rows={billing.clients}
                rowKey={(c) => c.key}
                maxHeight="45vh"
                footer={{
                  label: t('income.byClientFooter', { count: n(billing.clientCount) }),
                  values: { billed: billing.billed, collected: billing.collected, pending: billing.pending },
                }}
              />
            </Panel>
          )}

          <Panel flush title={t('income.detail')} hint={scopeLabel} footer={t('income.readOnlyNote')}>
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <div className="relative flex min-w-[220px] max-w-[320px] flex-1 items-center max-sm:max-w-none">
                <Search aria-hidden className="pointer-events-none absolute left-2.5 size-[15px] text-text-3" />
                <Input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('income.search')}
                  aria-label={t('income.search')}
                  className="pl-8 pr-8"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
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

            <FinTable
              caption={t('income.detail')}
              columns={lineColumns}
              rows={visibleLines}
              rowKey={(l) => l.id}
              maxHeight="65vh"
              footer={
                visibleLines.length > 0
                  ? {
                      label: lineFooterLabel,
                      values: {
                        amount: visibleTotals.amount,
                        received: visibleTotals.received,
                        pending: visibleTotals.pending,
                      },
                    }
                  : undefined
              }
              empty={
                searchQuery ? (
                  <EmptyState compact icon={Search} title={t('income.noResults')} />
                ) : (
                  <EmptyState compact icon={TrendingUp} title={t('income.noIncome')} />
                )
              }
            />
          </Panel>
        </>
      )}
    </div>
  );
}
