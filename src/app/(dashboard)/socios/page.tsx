'use client';

import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { PeriodSelector } from '@/components/period-selector';
import { usePeriod } from '@/lib/period-context';
import { DEMO_PERIODS, DEMO_PARTNERS, DEMO_PARTNER_DISTRIBUTIONS, DEMO_FINANCIAL_STATUS, getPeriodSummary, computeSaldoChain, isPeriodAfterSaldoStart } from '@/lib/demo-data';
import { formatCurrency, formatPercent } from '@/lib/utils';
import { downloadCSV } from '@/lib/csv-export';
import { useI18n } from '@/lib/i18n';
import { Users, Download, AlertTriangle, TrendingDown, TrendingUp, Wallet } from 'lucide-react';

const COLORS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B'];

export default function SociosPage() {
  const { t } = useI18n();
  const { mode, selectedPeriodId, selectedPeriodIds } = usePeriod();

  const saldoChain = useMemo(() => computeSaldoChain(), []);

  // Get current period info
  const currentPeriodId = mode === 'single' ? selectedPeriodId : null;
  const saldoInfo = currentPeriodId ? saldoChain.get(currentPeriodId) : null;
  const appliesSaldo = currentPeriodId ? isPeriodAfterSaldoStart(currentPeriodId) : false;

  // Get operating income for current view
  const summary = mode === 'single' ? getPeriodSummary(selectedPeriodId) : null;
  const ingresosNetos = summary?.operatingIncome
    ? summary.operatingIncome.prop_firm + summary.operatingIncome.broker_pnl + summary.operatingIncome.other
    : 0;
  const netoMes = summary?.financialStatus?.net_total || 0;

  // Total to distribute: if saldo logic applies, use computed; otherwise use raw partner distributions
  const totalToDistribute = appliesSaldo && saldoInfo ? saldoInfo.totalDistribuir : ingresosNetos;

  const distributions = mode === 'consolidated'
    ? (() => {
        const allDists = DEMO_PARTNER_DISTRIBUTIONS.filter(d => selectedPeriodIds.includes(d.period_id));
        const byPartner = new Map<string, { id: string; period_id: string; partner_id: string; company_id: string; percentage: number; amount: number }>();
        for (const dist of allDists) {
          const existing = byPartner.get(dist.partner_id);
          if (existing) {
            existing.amount += dist.amount;
          } else {
            byPartner.set(dist.partner_id, { ...dist, id: `cons-${dist.partner_id}`, period_id: 'consolidated' });
          }
        }
        return Array.from(byPartner.values());
      })()
    : DEMO_PARTNER_DISTRIBUTIONS.filter(d => d.period_id === selectedPeriodId);

  // For open periods with saldo logic, recalculate amounts based on totalToDistribute
  const effectiveDistributions = appliesSaldo && mode === 'single'
    ? distributions.map(d => ({
        ...d,
        amount: totalToDistribute * d.percentage,
      }))
    : distributions;

  const totalDistributed = effectiveDistributions.reduce((sum, d) => sum + d.amount, 0);
  const totalPercentage = effectiveDistributions.reduce((sum, d) => sum + d.percentage, 0);
  const percentageMismatch = Math.abs(totalPercentage - 1) > 0.001;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('partners.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('partners.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const headers = ['Socio', 'Porcentaje', 'Monto'];
              const rows = effectiveDistributions.map(d => {
                const partner = DEMO_PARTNERS.find(p => p.id === d.partner_id);
                return [partner?.name || '', `${(d.percentage * 100).toFixed(1)}%`, d.amount] as (string | number)[];
              });
              rows.push(['Total', '100%', totalDistributed]);
              downloadCSV('socios.csv', headers, rows);
            }}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
            title={t('common.csv')}
          >
            <Download className="w-4 h-4" />
            {t('common.csv')}
          </button>
          <PeriodSelector />
        </div>
      </div>

      {/* Percentage warning */}
      {percentageMismatch && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-sm font-medium">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {t('partners.percentageWarning', { pct: (totalPercentage * 100).toFixed(1) })}
        </div>
      )}

      {/* Summary cards */}
      <div className={`grid grid-cols-1 ${appliesSaldo ? 'md:grid-cols-4' : 'md:grid-cols-1'} gap-4`}>
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-violet-50 dark:bg-violet-950/50">
              <Users className="w-5 h-5 text-violet-500" />
            </div>
            <p className="text-sm text-muted-foreground">{t('partners.netIncome')}</p>
          </div>
          <p className={`text-2xl font-bold ${ingresosNetos >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {formatCurrency(ingresosNetos)}
          </p>
        </Card>

        {appliesSaldo && (
          <>
            <Card>
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/50">
                  {netoMes >= 0 ? <TrendingUp className="w-5 h-5 text-blue-500" /> : <TrendingDown className="w-5 h-5 text-red-500" />}
                </div>
                <p className="text-sm text-muted-foreground">{t('partners.netoMes')}</p>
              </div>
              <p className={`text-2xl font-bold ${netoMes >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {formatCurrency(netoMes)}
              </p>
            </Card>

            <Card>
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/50">
                  <Wallet className="w-5 h-5 text-amber-500" />
                </div>
                <p className="text-sm text-muted-foreground">{t('partners.saldoFavor')}</p>
              </div>
              <p className="text-2xl font-bold">{formatCurrency(saldoInfo?.saldoNuevo || 0)}</p>
              {saldoInfo && saldoInfo.saldoUsado > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  {t('partners.saldoUsed', { used: formatCurrency(saldoInfo.saldoUsado), total: formatCurrency(saldoInfo.saldoAnterior) })}
                </p>
              )}
            </Card>

            <Card>
              <div className="flex items-center gap-3 mb-2">
                <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50">
                  <Users className="w-5 h-5 text-emerald-500" />
                </div>
                <p className="text-sm text-muted-foreground">{t('partners.totalDistribute')}</p>
              </div>
              <p className={`text-2xl font-bold ${totalToDistribute >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {formatCurrency(totalToDistribute)}
              </p>
            </Card>
          </>
        )}
      </div>

      {/* Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Table */}
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('partners.distribution')}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('partners.name')}</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">%</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('partners.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {effectiveDistributions.map((dist, i) => {
                const partner = DEMO_PARTNERS.find(p => p.id === dist.partner_id);
                return (
                  <tr key={dist.id} className="border-b border-border/50 hover:bg-muted/50">
                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full"
                          style={{ backgroundColor: COLORS[i % COLORS.length] }}
                        />
                        {partner?.name || '—'}
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right font-medium">{formatPercent(dist.percentage)}</td>
                    <td className={`py-3 px-3 text-right font-bold ${dist.amount < 0 ? 'text-red-600' : ''}`}>
                      {formatCurrency(dist.amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-bold bg-muted/50">
                <td className="py-3 px-3">Total</td>
                <td className="py-3 px-3 text-right">100%</td>
                <td className={`py-3 px-3 text-right ${totalDistributed < 0 ? 'text-red-600' : ''}`}>
                  {formatCurrency(totalDistributed)}
                </td>
              </tr>
            </tfoot>
          </table>
        </Card>

        {/* Visual bar chart */}
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('partners.participation')}</h2>
          <div className="space-y-4">
            {effectiveDistributions.map((dist, i) => {
              const partner = DEMO_PARTNERS.find(p => p.id === dist.partner_id);
              return (
                <div key={dist.id}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="font-medium">{partner?.name}</span>
                    <span className="text-muted-foreground">{formatPercent(dist.percentage)}</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-4">
                    <div
                      className="h-4 rounded-full transition-all duration-500"
                      style={{
                        width: `${dist.percentage * 100}%`,
                        backgroundColor: COLORS[i % COLORS.length],
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Historical summary with neto mes and saldo */}
          <div className="mt-8">
            <h3 className="text-sm font-semibold text-muted-foreground mb-3">{t('partners.history')}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-1.5 px-2">{t('partners.period')}</th>
                    <th className="text-right py-1.5 px-2">{t('partners.netoMes')}</th>
                    <th className="text-right py-1.5 px-2">{t('partners.saldoFavor')}</th>
                    {DEMO_PARTNERS.map(p => (
                      <th key={p.id} className="text-right py-1.5 px-2">{p.name}</th>
                    ))}
                    <th className="text-right py-1.5 px-2">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {DEMO_PERIODS.map((period) => {
                    const dists = DEMO_PARTNER_DISTRIBUTIONS.filter(d => d.period_id === period.id);
                    const sInfo = saldoChain.get(period.id);
                    const hasSaldo = isPeriodAfterSaldoStart(period.id);
                    const fs = DEMO_FINANCIAL_STATUS.find(f => f.period_id === period.id);

                    // For periods with saldo logic, recalculate
                    const effectiveDists = hasSaldo && sInfo
                      ? dists.map(d => ({ ...d, amount: sInfo.totalDistribuir * d.percentage }))
                      : dists;
                    const total = effectiveDists.reduce((s, d) => s + d.amount, 0);

                    return (
                      <tr key={period.id} className={`border-b border-border/30 ${period.id === selectedPeriodId ? 'bg-blue-50 dark:bg-blue-950/50' : ''}`}>
                        <td className="py-1.5 px-2 font-medium">{period.label}</td>
                        <td className={`py-1.5 px-2 text-right ${(fs?.net_total || 0) < 0 ? 'text-red-600' : ''}`}>
                          {hasSaldo ? formatCurrency(fs?.net_total || 0) : '-'}
                        </td>
                        <td className="py-1.5 px-2 text-right">
                          {hasSaldo ? formatCurrency(sInfo?.saldoNuevo || 0) : '-'}
                        </td>
                        {DEMO_PARTNERS.map(p => {
                          const d = effectiveDists.find(dd => dd.partner_id === p.id);
                          return (
                            <td key={p.id} className={`py-1.5 px-2 text-right ${(d?.amount || 0) < 0 ? 'text-red-600' : ''}`}>
                              {formatCurrency(d?.amount || 0)}
                            </td>
                          );
                        })}
                        <td className={`py-1.5 px-2 text-right font-bold ${total < 0 ? 'text-red-600' : ''}`}>
                          {formatCurrency(total)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
