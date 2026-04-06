'use client';

import { Card, CardTitle, CardValue } from '@/components/ui/card';
import { PeriodSelector } from '@/components/period-selector';
import { MonthlyChart } from '@/components/charts/monthly-chart';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { downloadCSV } from '@/lib/csv-export';
import { downloadExcel, downloadPDF } from '@/lib/export-utils';
import { useI18n } from '@/lib/i18n';
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
} from 'lucide-react';

export default function ResumenPage() {
  const { t } = useI18n();
  const { mode, selectedPeriodId, selectedPeriodIds } = usePeriod();
  const { getPeriodSummary, getConsolidatedSummary } = useData();

  const summary = mode === 'consolidated'
    ? getConsolidatedSummary(selectedPeriodIds)
    : getPeriodSummary(selectedPeriodId);

  if (!summary) return null;

  const handleExport = () => {
    const headers = ['Metrica', 'Valor'];
    const rows: (string | number)[][] = [
      ['Depósitos Totales', summary.totalDeposits],
      ['Retiros Totales', summary.totalWithdrawals],
      ['Net Deposit', summary.netDeposit],
      ['Egresos Operativos', summary.totalExpenses],
      ['Prop Firm', summary.operatingIncome?.prop_firm || 0],
      ['Broker P&L', summary.operatingIncome?.broker_pnl || 0],
      ['Balance Disponible', totalIncome - summary.totalExpenses],
    ];
    downloadCSV(`resumen_${(summary.period.label || 'export').replace(/\s/g, '_')}.csv`, headers, rows);
  };

  const exportHeaders = ['Metrica', 'Valor'];
  const exportRows: (string | number)[][] = [
    ['Depósitos Totales', summary.totalDeposits],
    ['Retiros Totales', summary.totalWithdrawals],
    ['Net Deposit', summary.netDeposit],
    ['Egresos Operativos', summary.totalExpenses],
    ['Prop Firm', summary.operatingIncome?.prop_firm || 0],
    ['Broker P&L', summary.operatingIncome?.broker_pnl || 0],
    ['Balance Disponible', summary.financialStatus?.current_month_balance || 0],
  ];

  const handleExportExcel = () => {
    downloadExcel(`resumen_${(summary.period.label || 'export').replace(/\s/g, '_')}`, exportHeaders, exportRows);
  };

  const handleExportPDF = () => {
    downloadPDF('Resumen General', exportHeaders, exportRows, {
      companyName: 'Vex Pro',
      subtitle: `Período: ${summary.period.label}`,
      date: new Date().toLocaleDateString(),
    });
  };

  const income = summary.operatingIncome;
  const totalIncome = income
    ? income.prop_firm + income.broker_pnl + income.other
    : 0;
  const fs = summary.financialStatus;

  // Dynamic balance: Operating Income - Operating Expenses
  const balanceDisponible = totalIncome - summary.totalExpenses;

  // saldoChain is used in socios page, not needed here anymore

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('summary.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('summary.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
            title={t('common.csv')}
          >
            <Download className="w-4 h-4" />
            {t('common.csv')}
          </button>
          <button
            onClick={handleExportExcel}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
            title="Excel"
          >
            <FileSpreadsheet className="w-4 h-4" />
            Excel
          </button>
          <button
            onClick={handleExportPDF}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
            title="PDF"
          >
            <FileText className="w-4 h-4" />
            PDF
          </button>
          <PeriodSelector />
        </div>
      </div>

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
          <CardValue>{formatCurrency(summary.totalDeposits)}</CardValue>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950/50">
              <ArrowUpCircle className="w-5 h-5 text-red-500" />
            </div>
            <CardTitle>{t('summary.withdrawals')}</CardTitle>
          </div>
          <CardValue>{formatCurrency(summary.totalWithdrawals)}</CardValue>
        </Card>

        <Card>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50">
              <DollarSign className="w-5 h-5 text-emerald-500" />
            </div>
            <CardTitle>{t('summary.netDeposit')}</CardTitle>
          </div>
          <CardValue positive={summary.netDeposit > 0} negative={summary.netDeposit < 0}>
            {formatCurrency(summary.netDeposit)}
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
          {income && (
            <div className="mt-3 space-y-1 text-sm text-muted-foreground">
              <div className="flex justify-between">
                <span>{t('summary.propFirm')}</span>
                <span>{formatCurrency(income.prop_firm)}</span>
              </div>
              <div className="flex justify-between">
                <span>{t('summary.brokerPnl')}</span>
                <span>{formatCurrency(income.broker_pnl)}</span>
              </div>
            </div>
          )}
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
