'use client';

import { useMemo } from 'react';
import { Card, CardTitle, CardValue } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
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
import { useApiTotals, DEFAULT_WALLET_ID } from '@/components/realtime-movements-banner';
import { allPeriodsUseDerivedBroker, computeDerivedBroker } from '@/lib/broker-logic';
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
  const { getPeriodSummary, getConsolidatedSummary, periods } = useData();

  const summary = mode === 'consolidated'
    ? getConsolidatedSummary(selectedPeriodIds)
    : getPeriodSummary(selectedPeriodId);

  // Mirror the consolidation logic from /movimientos so both pages show the
  // SAME numbers for any given period. For "new broker" periods (April 2026+)
  // we blend live/persisted API data with manual "other" entries.
  const activePeriods = useMemo(() => {
    const ids = mode === 'consolidated' ? selectedPeriodIds : [selectedPeriodId];
    return periods.filter((p) => ids.includes(p.id));
  }, [mode, selectedPeriodId, selectedPeriodIds, periods]);
  const useDerivedBroker = useMemo(
    () => allPeriodsUseDerivedBroker(activePeriods),
    [activePeriods],
  );
  const { apiFrom, apiTo } = useMemo(() => {
    if (!useDerivedBroker || activePeriods.length === 0) return { apiFrom: '', apiTo: '' };
    const sorted = [...activePeriods].sort((a, b) => a.year - b.year || a.month - b.month);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const pad = (n: number) => String(n).padStart(2, '0');
    const lastDay = new Date(last.year, last.month, 0).getDate();
    return {
      apiFrom: `${first.year}-${pad(first.month)}-01`,
      apiTo: `${last.year}-${pad(last.month)}-${pad(lastDay)}`,
    };
  }, [useDerivedBroker, activePeriods]);
  const apiTotals = useApiTotals(apiFrom, apiTo, DEFAULT_WALLET_ID);

  if (!summary) return null;

  // ─── Consolidation: API + manual coexist ───
  // Same formula Movimientos uses. Every channel/category sums both sources
  // so the number shown here always matches what Movimientos shows.

  // Deposits per channel: API amount (when derived-logic period) + manual.
  const manualCoinsbuy = summary.deposits.find((d) => d.channel === 'coinsbuy')?.amount || 0;
  const manualFairpay = summary.deposits.find((d) => d.channel === 'fairpay')?.amount || 0;
  const manualUnipayment = summary.deposits.find((d) => d.channel === 'unipayment')?.amount || 0;
  const storedOther = summary.deposits.find((d) => d.channel === 'other')?.amount || 0;

  const apiCoinsbuy = useDerivedBroker ? apiTotals.by['coinsbuy-deposits'] ?? 0 : 0;
  const apiFairpay = useDerivedBroker ? apiTotals.by['fairpay'] ?? 0 : 0;
  const apiUnipayment = useDerivedBroker ? apiTotals.by['unipayment'] ?? 0 : 0;

  const consolidatedDeposits = useDerivedBroker
    ? (apiCoinsbuy + manualCoinsbuy) +
      (apiFairpay + manualFairpay) +
      (apiUnipayment + manualUnipayment) +
      storedOther
    : summary.totalDeposits;

  // Withdrawals: broker = derived-from-API + manual, others are manual-only.
  const ibCommissions = summary.withdrawals.find((w) => w.category === 'ib_commissions')?.amount || 0;
  const propFirmWithdrawal = summary.withdrawals.find((w) => w.category === 'prop_firm')?.amount || 0;
  const otherWithdrawal = summary.withdrawals.find((w) => w.category === 'other')?.amount || 0;
  const storedBroker = summary.withdrawals.find((w) => w.category === 'broker')?.amount || 0;
  const derivedBrokerFromApi = useDerivedBroker
    ? computeDerivedBroker({
        apiWithdrawalsTotal: apiTotals.withdrawalsTotal,
        ibCommissions,
        propFirm: propFirmWithdrawal,
        other: otherWithdrawal,
      })
    : 0;
  const brokerConsolidated = useDerivedBroker
    ? derivedBrokerFromApi + storedBroker
    : storedBroker;
  const consolidatedWithdrawals = useDerivedBroker
    ? brokerConsolidated + ibCommissions + propFirmWithdrawal + otherWithdrawal
    : summary.totalWithdrawals;

  const consolidatedNetDeposit = consolidatedDeposits - consolidatedWithdrawals;

  const income = summary.operatingIncome;
  const totalIncome = (income
    ? income.broker_pnl + income.other
    : 0) + summary.propFirmNetIncome;
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
      companyName: 'Vex Pro',
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
            <CardTitle>{t('summary.netDeposit')}</CardTitle>
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
            <CardTitle>{t('summary.balance')}</CardTitle>
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
