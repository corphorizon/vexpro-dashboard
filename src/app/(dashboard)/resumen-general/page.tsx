'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { BarChart3, Download, FileSpreadsheet, FileText } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { Notice } from '@/components/ui/notice';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/info-tip';
import { ConsolidatedBadge } from '@/components/ui/consolidated-badge';
import { PeriodSelector } from '@/components/period-selector';
import { NoPeriodsState } from '@/components/no-periods-state';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { GLOSSARY } from '@/lib/glossary';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { features } from '@/lib/business-model';
import { formatMoney, MONEY_LOCALE } from '@/lib/money';
import { downloadCSV } from '@/lib/csv-export';
import { downloadExcel, downloadPDF } from '@/lib/export-utils';
import { useAuth } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { sumChain } from '@/lib/chain-view';
import { useApiCoexistence } from '@/lib/use-api-coexistence';
import { withdrawalChannelLabel } from '@/lib/withdrawal-channels';
import { manualDepositsByChannel } from '@/lib/deposit-channels';
import { buildExpenses, UNCATEGORIZED } from '@/lib/reports/company-report';
import { cn } from '@/lib/utils';
import {
  expenseBasisGap,
  expenseCategoryRows,
  waterfallForPeriod,
  waterfallForRange,
  waterfallMismatches,
  type ExpenseCategoryTableRow,
  type WaterfallTableRow,
} from './waterfall-rows';

// ─────────────────────────────────────────────────────────────────────────────
// /resumen-general — «Libro mayor» (2026-10-12, T3).
//
// Orden: cabecera → KPIs (resultado; flujo de clientes en bróker) → avisos →
// cascada del resultado → egresos por categoría → evolución mensual.
//
// QUÉ CAMBIÓ Y POR QUÉ
//   · La cascada («Cómo se llega al resultado») sale de `buildCloseWaterfall`
//     — la función del PDF de cierre — con sus mismas filas y sus controles de
//     cuadre (waterfall-rows.ts). Antes la pantalla tenía su propio desglose
//     en una tarjeta y no mostraba reserva, deuda ni monto a distribuir: el
//     mismo mes contado de dos maneras, una en papel y otra en pantalla.
//   · Un control de cuadre que no da es un `Notice bad` con la cifra (antes
//     no existía en pantalla: sólo el PDF lo imprimía).
//   · KPIs desde `sumChain` (chain-view.ts): con una serie del CRM en vuelo,
//     Ingresos / Resultado / A distribuir son «—» + badge `stale`, nunca el
//     fallback 0 de la cadena (incidente 2026-10-05).
//   · Egresos por categoría: `buildExpenses` (company-report.ts), la misma
//     agrupación del reporte de /finanzas/reportes. Si el total cargado no es
//     el egreso que usa el resultado (base caja en `company`, congelado al
//     cierre), el pie lo dice con las dos cifras.
//   · Color = significado: fuera `text-amber-600`, `dark:text-accent`,
//     `text-[10px]` y las tarjetas con ícono de color.
//
// LO QUE NO CAMBIÓ: los exportes (CSV / Excel / PDF) — mismas columnas,
// mismas filas, mismo nombre de archivo; los montos salen de las mismas
// fuentes (cadena canónica y consolidación API + manual).
//
// QUEDÓ FUERA: «egresos por unidad». Un egreso no tiene unidad de negocio
// (`expenses` no tiene columna de unidad ni la tiene la orden de pago que lo
// origina; las unidades viven en las UBICACIONES de caja, no en los gastos).
// Inventar un reparto sería un número sin fuente.
// ─────────────────────────────────────────────────────────────────────────────

// PERF-03: recharts (~350KB) se carga on-demand — solo esta página lo usa.
const MonthlyChart = dynamic(
  () => import('@/components/charts/monthly-chart').then((m) => m.MonthlyChart),
  {
    ssr: false,
    loading: () => <div className="flex h-[350px] items-center justify-center text-[13px] text-text-3">…</div>,
  },
);

/** Botón secundario de cabecera (spec §5.1: 32 px, borde `border-strong`). */
const BTN =
  'inline-flex h-8 items-center gap-1.5 rounded-ui-md border border-border-strong bg-card px-3 text-[13px] font-medium text-foreground hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:h-10';

const pctFmt = new Intl.NumberFormat(MONEY_LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export default function ResumenPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const { mode, selectedPeriodId, selectedPeriodIds } = usePeriod();
  const {
    getPeriodSummary,
    getConsolidatedSummary,
    computeSaldoChain,
    getBrokerPnl,
    periods,
    company,
    loading,
    autoSeriesStatus,
  } = useData();
  // Una consultora no mueve fondos de clientes: sin depósitos, "Net Deposit" y
  // el P&L del broker no significan nada y se van de la pantalla (y del export).
  const model = features(company?.business_model);
  const showNetDeposit = model.netDeposit;
  const showBrokerPnl = model.brokerPnl;

  const summary = mode === 'consolidated' ? getConsolidatedSummary(selectedPeriodIds) : getPeriodSummary(selectedPeriodId);

  const ids = useMemo(
    () => (mode === 'consolidated' ? selectedPeriodIds : [selectedPeriodId]),
    [mode, selectedPeriodId, selectedPeriodIds],
  );
  const activePeriods = useMemo(() => periods.filter((p) => ids.includes(p.id)), [ids, periods]);
  // BUG-05: totales scopeados al set de wallets pinneadas ('' → modo 'pinned'),
  // igual que /movimientos y /balances — net deposit consistente entre pantallas.
  const coexist = useApiCoexistence(activePeriods, '');
  const useDerivedBroker = coexist.useDerivedBroker;

  // ─── Resultado — CADENA CANÓNICA ─────────────────────────────────────────
  // Mismos insumos (buildDistributionInputs + applySnapshotOverrides) y misma
  // fórmula que /socios y /balances. En consolidado se suman los períodos
  // seleccionados (sumChain: null en cuanto un sumando no es definitivo).
  const saldoChain = useMemo(() => computeSaldoChain(), [computeSaldoChain]);
  const entries = useMemo(() => ids.map((id) => saldoChain.get(id)), [ids, saldoChain]);
  const kpis = useMemo(() => sumChain(entries, autoSeriesStatus), [entries, autoSeriesStatus]);

  // ─── Broker P&L, con su procedencia ─────────────────────────────────────
  // La procedencia del conjunto es la del PEOR caso: si a alguno le falta el
  // dato el conjunto es 'none'; si alguno viene congelado, 'frozen'.
  const brokerPnl = useMemo(() => {
    const partes = ids.map((id) => getBrokerPnl(id)).filter((r) => r !== null);
    if (partes.length === 0) return null;
    if (partes.some((r) => r.value === null)) {
      return { value: null, source: 'none' as const, daysWithData: null, daysInMonth: null };
    }
    const value = Math.round(partes.reduce((s, r) => s + (r.value as number), 0) * 100) / 100;
    if (partes.length === 1) {
      return { value, source: partes[0].source, daysWithData: partes[0].daysWithData, daysInMonth: partes[0].daysInMonth };
    }
    const source = partes.every((r) => r.source === 'crm') ? ('crm' as const) : ('frozen' as const);
    // "27 de 31" no significa nada sobre cuatro meses sumados.
    return { value, source, daysWithData: null, daysInMonth: null };
  }, [ids, getBrokerPnl]);

  // ─── Cascada ────────────────────────────────────────────────────────────
  // Rótulo de `other`: en una empresa de servicios es la facturación cobrada
  // (mismo criterio que el «Cierre mensual» de /socios).
  const otherLabel = model.movements ? undefined : 'Facturación cobrada';
  const waterfall = useMemo(() => {
    const found = entries.filter((e) => e != null);
    if (found.length === 0 || found.length < entries.length) return null;
    if (mode === 'single') {
      const period = periods.find((p) => p.id === selectedPeriodId);
      return waterfallForPeriod(found[0], period?.reserve_pct, otherLabel);
    }
    return waterfallForRange(found, otherLabel);
  }, [entries, mode, periods, selectedPeriodId, otherLabel]);
  const mismatches = waterfall ? waterfallMismatches(waterfall.result) : [];

  // ─── Egresos por categoría ──────────────────────────────────────────────
  const expenseReport = useMemo(() => (summary ? buildExpenses(summary.expenses) : null), [summary]);

  // Sin períodos no hay nada que cargar: un esqueleto eterno haría creer que
  // el sistema está trabajando.
  if (!loading && periods.length === 0) return <NoPeriodsState />;

  if (!summary) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-[92px]" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  // ─── Flujo de clientes: API + manual (misma fórmula que /movimientos) ───
  // El manual sale del registro único de canales.
  const manualByChannel = manualDepositsByChannel(summary.deposits);
  const consolidatedDeposits = useDerivedBroker
    ? coexist.apiDepositsTotal(manualByChannel) + manualByChannel.other
    : summary.totalDeposits;
  // Retiros — Kevin (2026-06-06, decisión final): API + manual Broker
  // (suplemento Coinsbuy). Comisiones IB / Prop Firm / Otros son informativos.
  const storedBroker = summary.withdrawals.find((w) => w.category === 'broker')?.amount || 0;
  const consolidatedWithdrawals = useDerivedBroker ? coexist.apiWithdrawalsTotal + storedBroker : summary.totalWithdrawals;
  const consolidatedNetDeposit = consolidatedDeposits - consolidatedWithdrawals;
  // En pantalla, con la API del período derivado caída o en vuelo, el flujo es
  // «no lo sabemos» (como en /movimientos), no la suma de lo manual.
  const flowKnown = !useDerivedBroker || coexist.apiFetchState === 'ok';
  const flowBadge = coexist.apiFetchState === 'loading'
    ? { kind: 'stale' as const, label: t('summary.flow.loading') }
    : { kind: 'bad' as const, label: t('summary.flow.failed') };
  const missingWithdrawalChannels =
    useDerivedBroker && coexist.withdrawalChannelsWithoutData.length > 0
      ? coexist.withdrawalChannelsWithoutData.map((c) => withdrawalChannelLabel(c, t)).join(', ')
      : null;

  // ─── Exportes (sin cambios de formato) ──────────────────────────────────
  // Pendiente de datos del CRM ⇒ se exporta el estado, no el número falso.
  const incomePendingLabel = kpis.ownState?.label ?? null;
  const exportHeaders = ['Metrica', 'Valor'];
  const exportRows: (string | number)[][] = [
    ...(showNetDeposit
      ? ([
          ['Depósitos Totales', consolidatedDeposits],
          ['Retiros Totales', consolidatedWithdrawals],
          ['Net Deposit', consolidatedNetDeposit],
        ] as (string | number)[][])
      : []),
    ['Egresos Operativos', kpis.egresosNetos ?? '—'],
    ['Ingresos Operativos', incomePendingLabel ?? kpis.ingresosNetos ?? '—'],
    ['Balance Total', incomePendingLabel ?? kpis.resultado ?? '—'],
  ];
  const fileBase = `resumen_${(summary.period.label || 'export').replace(/\s/g, '_')}`;
  const handleExport = () => verify2FA(() => downloadCSV(`${fileBase}.csv`, exportHeaders, exportRows));
  const handleExportExcel = () => verify2FA(() => downloadExcel(fileBase, exportHeaders, exportRows));
  const handleExportPDF = () =>
    verify2FA(() => {
      downloadPDF('Resumen General', exportHeaders, exportRows, {
        companyName: company?.name ?? 'Smart Dashboard',
        subtitle: `Período: ${summary.period.label}`,
        date: new Date().toLocaleDateString(),
      });
    });

  // ─── KPIs ───────────────────────────────────────────────────────────────
  const ownBadge = kpis.ownState ? { kind: kpis.ownState.badge, label: kpis.ownState.label } : undefined;
  const chainBadge = kpis.chainState ? { kind: kpis.chainState.badge, label: kpis.chainState.label } : undefined;
  const resultItems: KpiItem[] = [
    {
      key: 'income',
      label: t('summary.kpi.income'),
      value: kpis.ingresosNetos,
      hero: true,
      missingBadge: ownBadge,
      sub: mode === 'consolidated' ? t('summary.kpi.months', { n: String(ids.length) }) : undefined,
    },
    { key: 'expenses', label: t('summary.kpi.expenses'), value: kpis.egresosNetos },
    {
      key: 'result',
      label: (
        <span className="inline-flex items-center gap-1">
          {t('summary.kpi.result')} <InfoTip text={GLOSSARY.netoOperativo} />
        </span>
      ),
      value: kpis.resultado,
      tone: 'sign',
      missingBadge: ownBadge,
    },
    {
      key: 'distribute',
      label: (
        <span className="inline-flex items-center gap-1">
          {t('summary.kpi.toDistribute')} <InfoTip text={GLOSSARY.montoDistribuir} />
        </span>
      ),
      value: kpis.aDistribuir,
      missingBadge: chainBadge,
      sub:
        kpis.aDistribuir !== null && kpis.reserva !== null && kpis.reserva > 0
          ? t('summary.kpi.afterReserve', { amount: formatMoney(kpis.reserva) })
          : undefined,
    },
  ];
  const flowItems: KpiItem[] = showNetDeposit
    ? [
        { key: 'deposits', label: t('summary.deposits'), value: flowKnown ? consolidatedDeposits : null, missingBadge: flowBadge },
        {
          key: 'withdrawals',
          label: t('summary.withdrawals'),
          value: flowKnown ? consolidatedWithdrawals : null,
          missingBadge: flowBadge,
          // Un canal de retiro que no se pudo leer NO está en este total, y
          // decirlo es obligatorio (reglas §1.2; auditoría 2026-08-31).
          sub: missingWithdrawalChannels
            ? t('movements.withdrawalsMissingChannels', { channels: missingWithdrawalChannels })
            : undefined,
        },
        {
          key: 'net',
          label: (
            <span className="inline-flex items-center gap-1">
              {t('summary.netDeposit')} <InfoTip text={GLOSSARY.netDeposit} />
            </span>
          ),
          value: flowKnown ? consolidatedNetDeposit : null,
          tone: 'sign',
          missingBadge: flowBadge,
        },
      ]
    : [];

  // ─── Columnas ───────────────────────────────────────────────────────────
  const waterfallLabel = (r: WaterfallTableRow) => {
    if (r.key === 'other' && otherLabel) return t('summary.waterfall.billing');
    if (r.key === 'reserva') {
      const pct = r.pdfLabel.match(/\(([^)]+)\)/)?.[1];
      return pct ? `${t('summary.waterfall.reserva')} (${pct})` : t('summary.waterfall.reserva');
    }
    if (r.key === 'unknown') return r.pdfLabel;
    const key = `summary.waterfall.${r.key}`;
    const tr = t(key);
    return tr === key ? r.pdfLabel : tr;
  };
  const brokerSourceLabel = brokerPnl
    ? brokerPnl.source === 'crm'
      ? t('brokerPnl.sourceCrm')
      : brokerPnl.source === 'frozen'
        ? t('brokerPnl.sourceFrozen')
        : t('brokerPnl.sourceNone')
    : null;
  const partialDays =
    brokerPnl?.source === 'crm' &&
    brokerPnl.daysWithData !== null &&
    brokerPnl.daysInMonth !== null &&
    brokerPnl.daysWithData < brokerPnl.daysInMonth
      ? t('brokerPnl.partialDays', { days: String(brokerPnl.daysWithData), total: String(brokerPnl.daysInMonth) })
      : null;
  const waterfallMeta = (r: WaterfallTableRow): React.ReactNode => {
    // Broker P&L DICE de dónde salió (Kevin, 2026-08-31): un número sin
    // procedencia es exactamente lo que había antes. Un mes incompleto tiene
    // que VERSE: 27 de 31 días es un número más chico y creíble.
    if (r.key === 'brokerPnl' && showBrokerPnl && brokerSourceLabel) {
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span>{t('summary.waterfall.source', { source: brokerSourceLabel })}</span>
          {partialDays && <StatusBadge kind="stale" label={partialDays} />}
        </span>
      );
    }
    if (r.amount === null && !r.isTotal && (r.key === 'brokerPnl' || r.key === 'propFirm')) {
      return kpis.ownState ? <StatusBadge kind="stale" label={kpis.ownState.label} /> : null;
    }
    return null;
  };
  const waterfallColumns: FinColumn<WaterfallTableRow>[] = [
    {
      key: 'concept',
      header: t('summary.waterfall.concept'),
      cell: (r) => (
        <span className={cn('inline-flex min-w-0 items-baseline gap-2', r.isTotal ? 'font-semibold' : 'font-normal')}>
          <span aria-hidden className={cn(NUM_CLASS, 'w-3 shrink-0 text-center text-text-3')}>
            {r.op}
          </span>
          <span className="truncate">{waterfallLabel(r)}</span>
        </span>
      ),
      meta: (r) => waterfallMeta(r),
    },
    {
      key: 'amount',
      header: t('summary.waterfall.amount'),
      kind: 'money',
      value: (r) => r.amount,
      subtotal: false,
      width: '180px',
      cell: (r) => (
        <Money
          value={r.amount}
          signed={!r.isTotal}
          tone={r.signTone ? 'sign' : r.isTotal ? 'auto' : 'neutral'}
          nullLabel={t('ui.noData')}
          className={r.isTotal ? 'font-semibold' : 'font-medium'}
        />
      ),
    },
  ];

  const categoryRows = expenseReport ? expenseCategoryRows(expenseReport.categories, expenseReport.total, UNCATEGORIZED) : [];
  const basisGap = expenseReport ? expenseBasisGap(expenseReport.total, kpis.egresosNetos) : null;
  const categoryColumns: FinColumn<ExpenseCategoryTableRow>[] = [
    {
      key: 'category',
      header: t('summary.categories.category'),
      cell: (r) => r.category ?? t('summary.categories.uncategorized'),
      meta: (r) => t('summary.categories.count', { n: String(r.count) }),
    },
    {
      key: 'share',
      header: '%',
      kind: 'number',
      hideSm: true,
      width: '132px',
      cell: (r) =>
        r.sharePct === null ? (
          <span className="text-text-3">—</span>
        ) : (
          <span className="inline-flex items-center justify-end gap-2">
            <span aria-hidden className="block h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunk">
              <span
                className="block h-full rounded-full bg-brand-ink/75"
                style={{ width: `${Math.max(0, Math.min(100, r.sharePct))}%` }}
              />
            </span>
            <span className={cn(NUM_CLASS, 'w-12 text-right text-text-2')}>{pctFmt.format(r.sharePct)} %</span>
          </span>
        ),
    },
    {
      key: 'pending',
      header: t('summary.categories.pending'),
      kind: 'money',
      value: (r) => r.pending,
      hideSm: true,
      width: '150px',
      money: { tone: 'neutral' },
    },
    {
      key: 'amount',
      header: t('summary.categories.amount'),
      kind: 'money',
      value: (r) => r.amount,
      width: '160px',
      money: { tone: 'neutral' },
    },
  ];

  const singlePeriod = mode === 'single' ? activePeriods[0] : null;

  return (
    <div className="space-y-4">
      {Modal2FA}
      <PageHeader
        title={t('summary.title')}
        subtitle={t('summary.subtitle')}
        icon={BarChart3}
        actions={
          <>
            <ConsolidatedBadge count={mode === 'consolidated' ? activePeriods.length : 1} />
            <button type="button" onClick={handleExport} className={BTN} title={t('common.csv')} aria-label={t('common.csv')}>
              <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="hidden sm:inline">{t('common.csv')}</span>
            </button>
            <button type="button" onClick={handleExportExcel} className={BTN} title="Excel" aria-label="Excel">
              <FileSpreadsheet aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="hidden sm:inline">Excel</span>
            </button>
            <button type="button" onClick={handleExportPDF} className={BTN} title="PDF" aria-label="PDF">
              <FileText aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="hidden sm:inline">PDF</span>
            </button>
            <PeriodSelector />
          </>
        }
      />

      <KpiStrip items={resultItems} />
      {flowItems.length > 0 && <KpiStrip items={flowItems} />}

      {/* ─── Avisos de estado del dato (spec §5.5) ─── */}
      {kpis.ownState && (
        <Notice kind={kpis.ownState.notice} title={kpis.ownState.label}>
          {t('summary.notice.crmBody')}
        </Notice>
      )}
      {!kpis.ownState && kpis.chainState && (
        <Notice kind={kpis.chainState.notice} title={t('summary.notice.inheritedTitle')}>
          {t('summary.notice.inheritedBody')}
        </Notice>
      )}
      {mismatches.length > 0 && (
        <Notice kind="bad" title={t('summary.notice.mismatchTitle')}>
          {mismatches.map((m) => (
            <span key={m.key} className="block">
              {t(m.key === 'ingresos' ? 'summary.notice.mismatchIncome' : 'summary.notice.mismatchDistribution', {
                amount: formatMoney(m.amount),
              })}
            </span>
          ))}
        </Notice>
      )}
      {kpis.resultado !== null && kpis.resultado < 0 && (
        <Notice kind="bad" title={t('summary.negativeBalance', { amount: formatMoney(kpis.resultado) })}>
          {waterfall && waterfall.result.deudaQuePasa > 0
            ? t('summary.notice.debtCarries', { amount: formatMoney(waterfall.result.deudaQuePasa) })
            : null}
        </Notice>
      )}

      {/* ─── Cascada del resultado ─── */}
      <Panel
        title={t('summary.waterfall.title')}
        hint={
          mode === 'consolidated'
            ? t('summary.waterfall.hintRange', { n: String(ids.length) })
            : singlePeriod?.label
              ? t('summary.waterfall.hintPeriod', { period: singlePeriod.label })
              : undefined
        }
        flush
        footer={
          mode === 'consolidated'
            ? t('summary.waterfall.rangeFoot')
            : waterfall && waterfall.result.deudaQuePasa > 0 && kpis.resultado !== null && kpis.resultado >= 0
              ? t('summary.notice.debtCarries', { amount: formatMoney(waterfall.result.deudaQuePasa) })
              : undefined
        }
      >
        {waterfall ? (
          <FinTable
            caption={t('summary.waterfall.title')}
            columns={waterfallColumns}
            rows={waterfall.rows}
            rowKey={(r) => `${r.key}-${r.pdfLabel}`}
            rowVariant={(r) => (r.isTotal ? 'total' : undefined)}
          />
        ) : (
          <p className="px-4 py-8 text-center text-[13px] text-text-3">{t('summary.waterfall.noChain')}</p>
        )}
      </Panel>

      {/* ─── Egresos por categoría ─── */}
      <Panel
        title={t('summary.categories.title')}
        hint={t('summary.categories.hint')}
        flush
        footer={
          basisGap !== null && expenseReport && kpis.egresosNetos !== null ? (
            <span>
              {t('summary.categories.basisGap', {
                loaded: formatMoney(expenseReport.total),
                used: formatMoney(kpis.egresosNetos),
              })}{' '}
              {model.cashBasisExpenses ? t('summary.categories.basisCash') : t('summary.categories.basisFrozen')}
            </span>
          ) : undefined
        }
      >
        <FinTable
          caption={t('summary.categories.title')}
          columns={categoryColumns}
          rows={categoryRows}
          rowKey={(r) => r.key}
          empty={t('summary.categories.empty')}
          footer={
            expenseReport && categoryRows.length > 0
              ? {
                  label: t('summary.categories.total', { n: String(categoryRows.length) }),
                  values: { amount: expenseReport.total, pending: expenseReport.pending },
                }
              : undefined
          }
        />
      </Panel>

      <Panel title={t('summary.chart')}>
        <MonthlyChart />
      </Panel>
    </div>
  );
}
