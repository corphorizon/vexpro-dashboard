'use client';

import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { PeriodSelector } from '@/components/period-selector';
import { usePeriod } from '@/lib/period-context';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { CHANNEL_LABELS, WITHDRAWAL_LABELS } from '@/lib/types';
import type { Deposit, Withdrawal } from '@/lib/types';
import { downloadCSV } from '@/lib/csv-export';
import { useI18n } from '@/lib/i18n';
import { Download } from 'lucide-react';

const ALL_CHANNELS: Array<'coinsbuy' | 'fairpay' | 'unipayment' | 'other'> = ['coinsbuy', 'fairpay', 'unipayment', 'other'];
const ALL_CATEGORIES: Array<'ib_commissions' | 'broker' | 'prop_firm' | 'other'> = ['ib_commissions', 'broker', 'prop_firm', 'other'];

export default function MovimientosPage() {
  const { t } = useI18n();
  const { mode, selectedPeriodId, selectedPeriodIds } = usePeriod();
  const { getPeriodSummary, getConsolidatedSummary } = useData();

  const summary = mode === 'consolidated'
    ? getConsolidatedSummary(selectedPeriodIds)
    : getPeriodSummary(selectedPeriodId);

  const handleExport = () => {
    if (!summary) return;
    const headers = [t('movements.type'), t('movements.category'), t('movements.amount')];
    const rows: (string | number)[][] = [
      ...summary.deposits.map(d => [t('movements.deposit'), CHANNEL_LABELS[d.channel], d.amount] as (string | number)[]),
      ...summary.withdrawals.map(w => [t('movements.withdrawal'), WITHDRAWAL_LABELS[w.category], w.amount] as (string | number)[]),
      ['', 'Net Deposit', summary.netDeposit],
    ];
    downloadCSV(`movimientos_${(summary.period.label || 'export').replace(/\s/g, '_')}.csv`, headers, rows);
  };

  // Ensure all channels/categories always appear, even with $0
  const fullDeposits: Deposit[] = useMemo(() => {
    if (!summary) return [];
    return ALL_CHANNELS.map(ch => {
      const existing = summary.deposits.find(d => d.channel === ch);
      return existing || { id: `empty-d-${ch}`, period_id: '', company_id: '', channel: ch, amount: 0, notes: null };
    });
  }, [summary]);

  const fullWithdrawals: Withdrawal[] = useMemo(() => {
    if (!summary) return [];
    return ALL_CATEGORIES.map(cat => {
      const existing = summary.withdrawals.find(w => w.category === cat);
      return existing || { id: `empty-w-${cat}`, period_id: '', company_id: '', category: cat, amount: 0, notes: null };
    });
  }, [summary]);

  if (!summary) return null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('movements.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('movements.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto">
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors flex-shrink-0"
            title={t('common.csv')}
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">{t('common.csv')}</span>
          </button>
          <PeriodSelector />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Depósitos */}
        <Card>
          <h2 className="text-lg font-semibold mb-4 text-blue-600">{t('movements.depositsTab')}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 text-muted-foreground font-medium">{t('movements.channel')}</th>
                <th className="text-right py-2 text-muted-foreground font-medium">{t('movements.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {fullDeposits.map((d) => (
                <tr key={d.id} className="border-b border-border/50">
                  <td className="py-2.5">{CHANNEL_LABELS[d.channel]}</td>
                  <td className="py-2.5 text-right font-medium">{formatCurrency(d.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-bold">
                <td className="py-3">{t('summary.deposits')}</td>
                <td className="py-3 text-right text-blue-600">{formatCurrency(summary.totalDeposits)}</td>
              </tr>
              <tr className="text-muted-foreground">
                <td className="py-1">{t('movements.propFirmSales')}</td>
                <td className="py-1 text-right">{formatCurrency(summary.propFirmSales)}</td>
              </tr>
              <tr className="text-muted-foreground">
                <td className="py-1">{t('movements.brokerDeposits')}</td>
                <td className="py-1 text-right">{formatCurrency(summary.brokerDeposits)}</td>
              </tr>
            </tfoot>
          </table>
        </Card>

        {/* Retiros */}
        <Card>
          <h2 className="text-lg font-semibold mb-4 text-red-600">{t('movements.withdrawalsTab')}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 text-muted-foreground font-medium">{t('movements.category')}</th>
                <th className="text-right py-2 text-muted-foreground font-medium">{t('movements.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {fullWithdrawals.map((w) => (
                <tr key={w.id} className="border-b border-border/50">
                  <td className="py-2.5">{WITHDRAWAL_LABELS[w.category]}</td>
                  <td className="py-2.5 text-right font-medium">{formatCurrency(w.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-bold">
                <td className="py-3">{t('summary.withdrawals')}</td>
                <td className="py-3 text-right text-red-600">{formatCurrency(summary.totalWithdrawals)}</td>
              </tr>
              <tr className="text-muted-foreground">
                <td className="py-1">{t('movements.p2pTransfer')}</td>
                <td className="py-1 text-right">{formatCurrency(summary.p2pTransfer)}</td>
              </tr>
              <tr className="font-bold border-t border-border">
                <td className="py-3">{t('movements.netDeposit')}</td>
                <td className={`py-3 text-right ${summary.netDeposit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {formatCurrency(summary.netDeposit)}
                </td>
              </tr>
            </tfoot>
          </table>
        </Card>

        {/* Balance Prop Firm */}
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('movements.balancePropFirm')}</h2>
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-border/50">
                <td className="py-2.5">{t('movements.propFirmSales')}</td>
                <td className="py-2.5 text-right font-medium">{formatCurrency(summary.propFirmSales)}</td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-2.5">{t('movements.propFirmWithdrawals')}</td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(summary.withdrawals.find(w => w.category === 'prop_firm')?.amount || 0)}
                </td>
              </tr>
              <tr className="font-bold">
                <td className="py-3">{t('movements.netIncome')}</td>
                <td className="py-3 text-right">
                  {formatCurrency(summary.propFirmNetIncome)}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>

        {/* Balance Broker */}
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('movements.balanceBroker')}</h2>
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-border/50">
                <td className="py-2.5">Broker P&L (Libro B)</td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(summary.operatingIncome?.broker_pnl || 0)}
                </td>
              </tr>
              <tr className="border-b border-border/50">
                <td className="py-2.5">Otros</td>
                <td className="py-2.5 text-right font-medium">
                  {formatCurrency(summary.operatingIncome?.other || 0)}
                </td>
              </tr>
              <tr className="font-bold">
                <td className="py-3">{t('movements.totalBroker')}</td>
                <td className="py-3 text-right">
                  {formatCurrency(
                    (summary.operatingIncome?.broker_pnl || 0) +
                    (summary.operatingIncome?.other || 0)
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
