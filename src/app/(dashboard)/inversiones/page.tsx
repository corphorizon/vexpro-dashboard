'use client';

import { useState, useMemo, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { downloadCSV } from '@/lib/csv-export';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useI18n } from '@/lib/i18n';
import type { Investment } from '@/lib/types';
import { TrendingUp, Download, ChevronLeft, ChevronRight } from 'lucide-react';

const MONTH_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const PAGE_SIZE = 50;

export default function InversionesPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const { getInvestmentsData } = useData();
  const [filter, setFilter] = useState('total');
  const [investmentsData, setInvestmentsData] = useState<Investment[]>([]);

  useEffect(() => {
    setInvestmentsData(getInvestmentsData());
  }, [getInvestmentsData]);

  const dataByYear = useMemo(() => {
    const map = new Map<number, Set<number>>();
    investmentsData.forEach(i => {
      const d = new Date(i.date);
      const year = d.getFullYear();
      if (!map.has(year)) map.set(year, new Set());
      map.get(year)!.add(d.getMonth() + 1);
    });
    return map;
  }, [investmentsData]);

  const availableYears = useMemo(() => Array.from(dataByYear.keys()).sort(), [dataByYear]);

  const [selectedYear, setSelectedYear] = useState<number>(0);

  useEffect(() => {
    if (availableYears.length > 0 && selectedYear === 0) {
      setSelectedYear(availableYears[availableYears.length - 1]);
    }
  }, [availableYears, selectedYear]);

  const filtered = useMemo(() => {
    if (filter === 'total') return investmentsData;
    return investmentsData.filter(i => {
      const d = new Date(i.date);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === filter;
    });
  }, [filter, investmentsData]);

  const lastBalance = filtered[filtered.length - 1]?.balance || 0;
  const totalDeposits = filtered.reduce((s, i) => s + i.deposit, 0);
  const totalWithdrawals = filtered.reduce((s, i) => s + i.withdrawal, 0);
  const totalProfit = filtered.reduce((s, i) => s + i.profit, 0);

  // Pagination
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [filter, investmentsData.length]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pagedRows = useMemo(
    () => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filtered, page],
  );

  return (
    <div className="space-y-6">
      {Modal2FA}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('investments.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('investments.subtitle')}</p>
        </div>
        <button
          onClick={() => verify2FA(() => {
            const headers = ['Fecha', 'Concepto', 'Responsable', 'Deposito', 'Retiro', 'Profit', 'Balance'];
            const rows = filtered.map(i => [i.date, i.concept || '', i.responsible || '', i.deposit, i.withdrawal, i.profit, i.balance] as (string | number)[]);
            downloadCSV('inversiones.csv', headers, rows);
          })}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors flex-shrink-0"
          title={t('common.csv')}
        >
          <Download className="w-4 h-4" />
          <span className="hidden sm:inline">{t('common.csv')}</span>
        </button>
      </div>

      {/* Filter */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium text-muted-foreground">{t('liquidity.filter')}</span>
        <button
          onClick={() => setFilter('total')}
          className={cn('px-3 py-1.5 text-xs font-medium rounded-md border transition-colors', filter === 'total' ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]' : 'border-border hover:bg-muted')}
        >
          {t('liquidity.total')}
        </button>
        <select
          value={selectedYear}
          onChange={e => {
            const yr = parseInt(e.target.value);
            setSelectedYear(yr);
            setFilter('total');
          }}
          className="px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-card"
        >
          {availableYears.map(yr => (
            <option key={yr} value={yr}>{yr}</option>
          ))}
        </select>
        {filter !== 'total' && (
          <span className="text-xs text-muted-foreground">|</span>
        )}
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: 12 }, (_, i) => i + 1).map(month => {
            const hasData = dataByYear.get(selectedYear)?.has(month);
            if (!hasData) return null;
            const ym = `${selectedYear}-${String(month).padStart(2, '0')}`;
            return (
              <button
                key={month}
                onClick={() => setFilter(ym)}
                className={cn('px-3 py-1.5 text-xs font-medium rounded-md border transition-colors', filter === ym ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]' : 'border-border hover:bg-muted')}
              >
                {MONTH_NAMES[month - 1]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50">
              <TrendingUp className="w-5 h-5 text-emerald-500" />
            </div>
            <p className="text-sm text-muted-foreground">{t('investments.currentBalance')}</p>
          </div>
          <p className="text-2xl font-bold">{formatCurrency(lastBalance)}</p>
        </Card>
        <Card>
          <p className="text-sm text-muted-foreground mb-1">{t('investments.totalInvested')}</p>
          <p className="text-2xl font-bold text-blue-600">{formatCurrency(totalDeposits)}</p>
        </Card>
        <Card>
          <p className="text-sm text-muted-foreground mb-1">{t('investments.totalWithdrawn')}</p>
          <p className="text-2xl font-bold text-red-600">{formatCurrency(totalWithdrawals)}</p>
        </Card>
        <Card>
          <p className="text-sm text-muted-foreground mb-1">{t('investments.profit')}</p>
          <p className="text-2xl font-bold text-emerald-600">{formatCurrency(totalProfit)}</p>
        </Card>
      </div>

      <Card>
        <h2 className="text-lg font-semibold mb-4">{t('investments.history')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-muted-foreground font-medium w-12">#</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Fecha</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Concepto</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Responsable</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Depósito</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Retiro</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Profit</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((inv, i) => (
                <tr key={inv.id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="py-2.5 px-3 text-muted-foreground tabular-nums">{page * PAGE_SIZE + i + 1}</td>
                  <td className="py-2.5 px-3">{new Date(inv.date).toLocaleDateString('es-ES')}</td>
                  <td className="py-2.5 px-3">{inv.concept || '—'}</td>
                  <td className="py-2.5 px-3">{inv.responsible || '—'}</td>
                  <td className="py-2.5 px-3 text-right font-medium text-blue-600">
                    {inv.deposit > 0 ? formatCurrency(inv.deposit) : '—'}
                  </td>
                  <td className="py-2.5 px-3 text-right font-medium text-red-600">
                    {inv.withdrawal > 0 ? formatCurrency(inv.withdrawal) : '—'}
                  </td>
                  <td className="py-2.5 px-3 text-right font-medium text-emerald-600">
                    {inv.profit > 0 ? formatCurrency(inv.profit) : '—'}
                  </td>
                  <td className="py-2.5 px-3 text-right font-bold">{formatCurrency(inv.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <p className="text-center text-muted-foreground py-8">{t('common.noData')}</p>
        )}
        {filtered.length > 0 && (
          <div className="flex items-center justify-between mt-4 text-sm flex-wrap gap-2">
            <span className="text-muted-foreground">
              Mostrando <strong className="text-foreground">{page * PAGE_SIZE + 1}</strong>
              –<strong className="text-foreground">{Math.min((page + 1) * PAGE_SIZE, filtered.length)}</strong>
              {' '}de <strong className="text-foreground">{filtered.length}</strong> items
            </span>
            {filtered.length > PAGE_SIZE && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="p-1.5 rounded border border-border hover:bg-muted disabled:opacity-40 disabled:pointer-events-none"
                  aria-label="Página anterior"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="px-2 tabular-nums">
                  Página {page + 1} de {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="p-1.5 rounded border border-border hover:bg-muted disabled:opacity-40 disabled:pointer-events-none"
                  aria-label="Página siguiente"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
