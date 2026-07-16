'use client';

import { useMemo } from 'react';
import { Card, CardTitle, CardValue } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/ui/page-header';
import { InfoTip } from '@/components/ui/info-tip';
import { GLOSSARY } from '@/lib/glossary';
import { ConsolidatedBadge } from '@/components/ui/consolidated-badge';
import { PeriodSelector } from '@/components/period-selector';
import dynamic from 'next/dynamic';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { downloadCSV } from '@/lib/csv-export';
import { downloadExcel, downloadPDF } from '@/lib/export-utils';
import { useAuth } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useI18n } from '@/lib/i18n';
import { useApiCoexistence } from '@/lib/use-api-coexistence';
import {
  ArrowDownCircle,
  ArrowUpCircle,
  TrendingUp,
  Receipt,
  DollarSign,
  Wallet,
  AlertTriangle,
  Download,
  FileSpreadsheet,
  FileText,
  BarChart3,
} from 'lucide-react';

// PERF-03: recharts (~350KB) se carga on-demand — solo esta página lo usa.
// dynamic + ssr:false lo saca del bundle inicial; placeholder de igual altura
// que el chart (350px) para evitar layout shift.
const MonthlyChart = dynamic(
  () => import('@/components/charts/monthly-chart').then((m) => m.MonthlyChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[350px] flex items-center justify-center text-sm text-muted-foreground">
        Cargando gráfico…
      </div>
    ),
  },
);

export default function ResumenPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const { mode, selectedPeriodId, selectedPeriodIds } = usePeriod();
  const { getPeriodSummary, getConsolidatedSummary, periods, company } = useData();

  const summary = mode === 'consolidated'
    ? getConsolidatedSummary(selectedPeriodIds)
    : getPeriodSummary(selectedPeriodId);

  // Single source of truth for the API + manual coexistence block. Same
  // hook feeds /movimientos so both pages can't drift.
  const activePeriods = useMemo(() => {
    const ids = mode === 'consolidated' ? selectedPeriodIds : [selectedPeriodId];
    return periods.filter((p) => ids.includes(p.id));
  }, [mode, selectedPeriodId, selectedPeriodIds, periods]);
  // Pass the tenant's preferred wallet so the API totals match what
  // /movimientos shows. Without this, useApiCoexistence defaulted to
  // "all wallets" — which inflated Retiros for tenants that have multiple
  // Coinsbuy wallets (e.g. Vex Pro: wallets 1079 + 1087 + 1076). Bug
  // reported by Kevin 2026-05-02.
  // BUG-05: totales scopeados al set de wallets pinneadas ('' → modo 'pinned'),
  // igual que /movimientos y /balances — net deposit consistente entre pantallas.
  const coexist = useApiCoexistence(activePeriods, '');
  const useDerivedBroker = coexist.useDerivedBroker;

  // Skeleton while the data-context hasn't produced a summary yet. A blank
  // page mid-load (what used to show) felt like the app was broken.
  if (!summary) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-56 rounded" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  // ─── Consolidation: API + manual coexist ───
  // Same formula Movimientos uses. Every channel/category sums both sources
  // so the number shown here always matches what Movimientos shows.

  // Deposits per channel: API amount (when derived-logic period) + manual.
  const manualCoinsbuy = summary.deposits.find((d) => d.channel === 'coinsbuy')?.amount || 0;
  const manualFairpay = summary.deposits.find((d) => d.channel === 'fairpay')?.amount || 0;
  const manualUnipayment = summary.deposits.find((d) => d.channel === 'unipayment')?.amount || 0;
  const storedOther = summary.deposits.find((d) => d.channel === 'other')?.amount || 0;

  const consolidatedDeposits = useDerivedBroker
    ? coexist.apiDepositsTotal(manualCoinsbuy, manualFairpay, manualUnipayment) + storedOther
    : summary.totalDeposits;

  // Withdrawals — Kevin (2026-06-06, decisión final): los retiros reales
  // son los datos de Coinsbuy = API + manual Broker (suplemento Coinsbuy).
  // Comisiones IB / Prop Firm / Otros son meramente informativos y NO
  // entran al total.
  //
  // Misma lógica que /movimientos y /admin-home — las tres vistas
  // calculan Retiros Totales idénticamente.
  const storedBroker = summary.withdrawals.find((w) => w.category === 'broker')?.amount || 0;
  const consolidatedWithdrawals = useDerivedBroker
    ? coexist.apiWithdrawalsTotal + storedBroker
    : summary.totalWithdrawals;

  const consolidatedNetDeposit = consolidatedDeposits - consolidatedWithdrawals;

  const income = summary.operatingIncome;
  const totalIncome = (income
    ? income.broker_pnl + income.other
    : 0)
    + summary.propFirmNetIncome
    + summary.investmentProfits;
  const balanceDisponible = totalIncome - summary.totalExpenses;

  const exportHeaders = ['Metrica', 'Valor'];
  const exportRows: (string | number)[][] = [
    ['Depósitos Totales', consolidatedDeposits],
    ['Retiros Totales', consolidatedWithdrawals],
    ['Net Deposit', consolidatedNetDeposit],
    ['Egresos Operativos', summary.totalExpenses],
    ['Ingresos Operativos', totalIncome],
    ['Balance Total', balanceDisponible],
  ];

  const handleExport = () => verify2FA(() => {
    downloadCSV(`resumen_${(summary.period.label || 'export').replace(/\s/g, '_')}.csv`, exportHeaders, exportRows);
  });

  const handleExportExcel = () => verify2FA(() => {
    downloadExcel(`resumen_${(summary.period.label || 'export').replace(/\s/g, '_')}`, exportHeaders, exportRows);
  });

  const handleExportPDF = () => verify2FA(() => {
    downloadPDF('Resumen General', exportHeaders, exportRows, {
      companyName: company?.name ?? 'Smart Dashboard',
      subtitle: `Período: ${summary.period.label}`,
      date: new Date().toLocaleDateString(),
    });
  });

  const fs = summary.financialStatus;

  return (
    <div className="space-y-6">
      {Modal2FA}
      <PageHeader
        title={t('summary.title')}
        subtitle={t('summary.subtitle')}
        icon={BarChart3}
        actions={
          <>
            <ConsolidatedBadge count={mode === 'consolidated' ? activePeriods.length : 1} />
            <Button onClick={handleExport} title={t('common.csv')}>
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">{t('common.csv')}</span>
            </Button>
            <Button onClick={handleExportExcel} title="Excel">
              <FileSpreadsheet className="w-4 h-4" />
              <span className="hidden sm:inline">Excel</span>
            </Button>
            <Button onClick={handleExportPDF} title="PDF">
              <FileText className="w-4 h-4" />
              <span className="hidden sm:inline">PDF</span>
            </Button>
            <PeriodSelector />
          </>
        }
      />

      {/* Negative balance warning */}
      {balanceDisponible < 0 && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-negative/10 border border-negative/30 text-negative text-sm font-medium">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {t('summary.negativeBalance', { amount: formatCurrency(balanceDisponible) })}
        </div>
      )}

      {/* KPI Cards — StatCard compartido con tonos semánticos: el color
          codifica significado (entrada/salida/resultado), no decoración. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label={t('summary.deposits')}
          value={formatCurrency(consolidatedDeposits)}
          icon={ArrowDownCircle}
          tone="info"
        />
        <StatCard
          label={t('summary.withdrawals')}
          value={formatCurrency(consolidatedWithdrawals)}
          icon={ArrowUpCircle}
          tone="negative"
        />
        <StatCard
          label={<>{t('summary.netDeposit')} <InfoTip text={GLOSSARY.netDeposit} /></>}
          value={formatCurrency(consolidatedNetDeposit)}
          icon={DollarSign}
          tone={consolidatedNetDeposit >= 0 ? 'positive' : 'negative'}
        />
        <StatCard
          label={t('summary.expenses')}
          value={formatCurrency(summary.totalExpenses)}
          icon={Receipt}
          tone="warning"
        />
      </div>

      {/* Second row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <TrendingUp className="w-5 h-5 text-primary dark:text-accent" />
            </div>
            <CardTitle>{t('summary.operatingIncome')}</CardTitle>
          </div>
          <CardValue positive={totalIncome > 0} negative={totalIncome < 0}>
            {formatCurrency(totalIncome)}
          </CardValue>
          <div className="mt-3 space-y-1 text-sm text-muted-foreground">
            {summary.propFirmNetIncome !== 0 && (
              <div className="flex justify-between">
                <span>Balance Prop Firm</span>
                <span>{formatCurrency(summary.propFirmNetIncome)}</span>
              </div>
            )}
            {summary.investmentProfits !== 0 && (
              <div className="flex justify-between">
                <span>Profits Inversiones</span>
                <span>{formatCurrency(summary.investmentProfits)}</span>
              </div>
            )}
            {income && (
              <div className="flex justify-between">
                <span>{t('summary.brokerPnl')}</span>
                <span>{formatCurrency(income.broker_pnl)}</span>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-info/10">
              <Wallet className="w-5 h-5 text-info" />
            </div>
            <CardTitle className="inline-flex items-center gap-1.5">
              {t('summary.balance')}
              <InfoTip text={GLOSSARY.netoOperativo} />
            </CardTitle>
          </div>
          <CardValue positive={balanceDisponible > 0} negative={balanceDisponible < 0}>
            {formatCurrency(balanceDisponible)}
          </CardValue>
          <div className="mt-3 space-y-1 text-sm text-muted-foreground">
            <div className="flex justify-between">
              <span>{t('summary.operatingIncome')}</span>
              <span className={totalIncome >= 0 ? 'text-positive' : 'text-negative'}>
                {formatCurrency(totalIncome)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>{t('summary.expenses')}</span>
              <span className="text-negative">
                -{formatCurrency(summary.totalExpenses)}
              </span>
            </div>
          </div>
        </Card>
      </div>

      {/* Chart */}
      <Card>
        <h2 className="text-lg font-semibold mb-4">{t('summary.chart')}</h2>
        <MonthlyChart />
      </Card>
    </div>
  );
}
