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
import type { LiquidityMovement } from '@/lib/types';
import { Droplets, Download, ChevronLeft, ChevronRight } from 'lucide-react';

const MONTH_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const PAGE_SIZE = 25;

export default function LiquidezPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const { getLiquidityData } = useData();
  const [filter, setFilter] = useState('total');
  const [liquidityData, setLiquidityData] = useState<LiquidityMovement[]>([]);

  useEffect(() => {
    setLiquidityData(getLiquidityData());
  }, [getLiquidityData]);

  const dataByYear = useMemo(() => {
    const map = new Map<number, Set<number>>();
    liquidityData.forEach(m => {
      const d = new Date(m.date);
      const year = d.getFullYear();
      if (!map.has(year)) map.set(year, new Set());
      map.get(year)!.add(d.getMonth() + 1);
    });
    return map;
  }, [liquidityData]);

  const availableYears = useMemo(() => Array.from(dataByYear.keys()).sort(), [dataByYear]);

  const [selectedYear, setSelectedYear] = useState<number>(0);

  useEffect(() => {
    if (availableYears.length > 0 && selectedYear === 0) {
      setSelectedYear(availableYears[availableYears.length - 1]);
    }
  }, [availableYears, selectedYear]);

  const filtered = useMemo(() => {
    if (filter === 'total') return liquidityData;
    return liquidityData.filter(m => {
      const d = new Date(m.date);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === filter;
    });
  }, [filter, liquidityData]);

  const lastBalance = filtered[filtered.length - 1]?.balance || 0;
  const totalDeposits = filtered.reduce((s, m) => s + m.deposit, 0);
  const totalWithdrawals = filtered.reduce((s, m) => s + m.withdrawal, 0);

  // Pagination — reset to page 0 whenever filter or data changes
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [filter, liquidityData.length]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pagedRows = useMemo(
    () => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filtered, page],
  );

  return (
    <div className="space-y-6">
      {Modal2FA}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('liquidity.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('liquidity.subtitle')}</p>
        </div>
        <button
          onClick={() => verify2FA(() => {
            const headers = ['Fecha', 'Usuario', 'Cuenta MT', 'Deposito', 'Retiro', 'Balance'];
            const rows = filtered.map(m => [m.date, m.user_email || '', m.mt_account || '', m.deposit, m.withdrawal, m.balance] as (string | number)[]);
            downloadCSV('liquidez.csv', headers, rows);
          })}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
          title={t('common.csv')}
        >
          <Download className="w-4 h-4" />
          {t('common.csv')}
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/50">
              <Droplets className="w-5 h-5 text-blue-500" />
            </div>
            <p className="text-sm text-muted-foreground">{t('liquidity.currentBalance')}</p>
          </div>
          <p className="text-2xl font-bold">{formatCurrency(lastBalance)}</p>
        </Card>
        <Card>
          <p className="text-sm text-muted-foreground mb-1">{t('liquidity.totalDeposits')}</p>
          <p className="text-2xl font-bold text-blue-600">{formatCurrency(totalDeposits)}</p>
        </Card>
        <Card>
          <p className="text-sm text-muted-foreground mb-1">{t('liquidity.totalWithdrawals')}</p>
          <p className="text-2xl font-bold text-red-600">{formatCurrency(totalWithdrawals)}</p>
        </Card>
      </div>

      <Card>
        <h2 className="text-lg font-semibold mb-4">{t('liquidity.history')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Fecha</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Usuario</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Cuenta MT</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Depósito</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Retiro</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.map((mov) => (
                <tr key={mov.id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="py-2.5 px-3">{new Date(mov.date).toLocaleDateString('es-ES')}</td>
                  <td className="py-2.5 px-3 text-xs max-w-[200px] truncate">{mov.user_email || '—'}</td>
                  <td className="py-2.5 px-3">{mov.mt_account || '—'}</td>
                  <td className="py-2.5 px-3 text-right font-medium text-blue-600">
                    {mov.deposit > 0 ? formatCurrency(mov.deposit) : '—'}
                  </td>
                  <td className="py-2.5 px-3 text-right font-medium text-red-600">
                    {mov.withdrawal > 0 ? formatCurrency(mov.withdrawal) : '—'}
                  </td>
                  <td className="py-2.5 px-3 text-right font-bold">{formatCurrency(mov.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <p className="text-center text-muted-foreground py-8">{t('common.noData')}</p>
        )}
        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center justify-between mt-4 text-sm">
            <span className="text-muted-foreground">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, filtered.length)} de {filtered.length}
            </span>
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
                {page + 1} / {totalPages}
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
          </div>
        )}
      </Card>
    </div>
  );
}
