'use client';

import { useMemo } from 'react';
import { Card, CardTitle, CardValue } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { InfoTip } from '@/components/ui/info-tip';
import { GLOSSARY } from '@/lib/glossary';
import { ConsolidatedBadge } from '@/components/ui/consolidated-badge';
import { PeriodSelector } from '@/components/period-selector';
import { MonthlyChart } from '@/components/charts/monthly-chart';
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
  const coexist = useApiCoexistence(activePeriods, company?.default_wallet_id ?? '');
  const useDerivedBroker = coexist.useDerivedBroker;

  // Skeleton while the data-context hasn't produced a summary yet. A blank
  // page mid-load (what used to show) felt like the app was broken.
  if (!summary) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-56 bg-muted rounded" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-28 rounded-xl bg-muted/60" />
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="h-48 rounded-xl bg-muted/60" />
          <div className="h-48 rounded-xl bg-muted/60" />
        </div>
        <div className="h-64 rounded-xl bg-muted/60" />
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

  // Withdrawals — Kevin (2026-05-03): el total de retiros es la salida
  // real de efectivo: API de Coinsbuy + "Otros" manuales. Broker /
  // Comisiones IB / Prop Firm son manuales informativos y NO entran en
  // el total (los retiros que pasaron por Coinsbuy ya están en la API).
  const otherWithdrawal = summary.withdrawals.find((w) => w.category === 'other')?.amount || 0;
  const consolidatedWithdrawals = useDerivedBroker
    ? coexist.apiWithdrawalsTotal + otherWithdrawal
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
            <button
              onClick={handleExport}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
              title={t('common.csv')}
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">{t('common.csv')}</span>
            </button>
            <button
              onClick={handleExportExcel}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
              title="Excel"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span className="hidden sm:inline">Excel</span>
            </button>
            <button
              onClick={handleExportPDF}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
              title="PDF"
            >
              <FileText className="w-4 h-4" />
              <span className="hidden sm:inline">PDF</span>
            </button>
            <PeriodSelector />
          </>
        }
      />

      {/* Negative balance warning */}
      {balanceDisponible < 0 && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm font-medium">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {t('summary.negativeBalance', { amount: formatCurrency(balanceDisponible) })}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/50">
              <ArrowDownCircle className="w-5 h-5 text-blue-500" />
            </div>
            <CardTitle>{t('summary.deposits')}</CardTitle>
          </div>
          <CardValue>{formatCurrency(consolidatedDeposits)}</CardValue>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950/50">
              <ArrowUpCircle className="w-5 h-5 text-red-500" />
            </div>
            <CardTitle>{t('summary.withdrawals')}</CardTitle>
          </div>
          <CardValue>{formatCurrency(consolidatedWithdrawals)}</CardValue>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50">
              <DollarSign className="w-5 h-5 text-emerald-500" />
            </div>
            <CardTitle className="inline-flex items-center gap-1.5">
              {t('summary.netDeposit')}
              <InfoTip text={GLOSSARY.netDeposit} />
            </CardTitle>
          </div>
          <CardValue positive={consolidatedNetDeposit > 0} negative={consolidatedNetDeposit < 0}>
            {formatCurrency(consolidatedNetDeposit)}
          </CardValue>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/50">
              <Receipt className="w-5 h-5 text-amber-500" />
            </div>
            <CardTitle>{t('summary.expenses')}</CardTitle>
          </div>
          <CardValue>{formatCurrency(summary.totalExpenses)}</CardValue>
        </Card>
      </div>

      {/* Second row */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-violet-50 dark:bg-violet-950/50">
              <TrendingUp className="w-5 h-5 text-violet-500" />
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
            <div className="p-2 rounded-lg bg-sky-50 dark:bg-sky-950/50">
              <Wallet className="w-5 h-5 text-sky-500" />
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
              <span className={totalIncome >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                {formatCurrency(totalIncome)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>{t('summary.expenses')}</span>
              <span className="text-red-600">
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
