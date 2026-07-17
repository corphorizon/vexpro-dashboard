'use client';

import { useState, useMemo, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatCard } from '@/components/ui/stat-card';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import { downloadCSV } from '@/lib/csv-export';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useI18n } from '@/lib/i18n';
import { TrendingUp, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { useRunningBalance } from '@/lib/use-running-balance';

const MONTH_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const PAGE_SIZE = 50;

export default function InversionesPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const { getInvestmentsData } = useData();
  const [filter, setFilter] = useState('total');
  // Read directly from the data-context — removing the local-state mirror
  // eliminates the flash-of-stale-data after add/edit/delete.
  const investmentsData = useMemo(() => getInvestmentsData(), [getInvestmentsData]);

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

  // Running balance computed on-the-fly. The stored `balance` column is
  // unreliable because addInvestmentRow / updateInvestment pass `balance: 0`
  // on insert. Formula matches recalcInvestmentBalances: deposit - withdrawal
  // + profit accumulated in date order.
  const balanceMap = useRunningBalance(
    investmentsData,
    inv => inv.deposit - inv.withdrawal + inv.profit,
  );

  const lastBalance = useMemo(() => {
    if (filtered.length === 0) {
      const sorted = [...investmentsData].sort((a, b) => a.date.localeCompare(b.date));
      return sorted.length > 0 ? balanceMap.get(sorted.at(-1)!.id) ?? 0 : 0;
    }
    const sortedFiltered = [...filtered].sort((a, b) => a.date.localeCompare(b.date));
    return balanceMap.get(sortedFiltered.at(-1)!.id) ?? 0;
  }, [filtered, investmentsData, balanceMap]);

  const totalDeposits = filtered.reduce((s, i) => s + i.deposit, 0);
  const totalWithdrawals = filtered.reduce((s, i) => s + i.withdrawal, 0);
  const totalProfit = filtered.reduce((s, i) => s + i.profit, 0);

  // Agregado: resumen por responsable. Agrupa las filas del filtro actual
  // por `inv.responsible`, sumando deposits, withdrawals, profit y calculando
  // balance = deposit - withdrawal + profit. Se ignoran filas sin responsable.
  // La misma fórmula del balance global se usa acá para consistencia.
  const perResponsibleTotals = useMemo(() => {
    const map = new Map<string, { deposits: number; withdrawals: number; profit: number; balance: number; count: number }>();
    for (const inv of filtered) {
      const responsible = (inv.responsible ?? '').trim();
      if (!responsible) continue;
      const existing = map.get(responsible) ?? { deposits: 0, withdrawals: 0, profit: 0, balance: 0, count: 0 };
      existing.deposits += inv.deposit;
      existing.withdrawals += inv.withdrawal;
      existing.profit += inv.profit;
      existing.balance += inv.deposit - inv.withdrawal + inv.profit;
      existing.count += 1;
      map.set(responsible, existing);
    }
    // Ordenar por balance descendente
    return Array.from(map.entries())
      .map(([responsible, totals]) => ({ responsible, ...totals }))
      .sort((a, b) => b.balance - a.balance);
  }, [filtered]);

  // Pagination
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [filter, investmentsData.length]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pagedRows = useMemo(
    () => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filtered, page],
  );

  // Número de fila global (respeta la paginación) — DataTable no expone el
  // índice en el accessor, así que se precalcula acá.
  const tableRows = pagedRows.map((inv, i) => ({ ...inv, rowNum: page * PAGE_SIZE + i + 1 }));

  return (
    <div className="space-y-6">
      {Modal2FA}
      <PageHeader
        title={t('investments.title')}
        subtitle={t('investments.subtitle')}
        icon={TrendingUp}
        actions={
          <button
            onClick={() => verify2FA(() => {
              const headers = ['Fecha', 'Concepto', 'Responsable', '+', '-', 'Profit', 'Balance'];
              const rows = filtered.map(i => [i.date, i.concept || '', i.responsible || '', i.deposit, i.withdrawal, i.profit, balanceMap.get(i.id) ?? 0] as (string | number)[]);
              downloadCSV('inversiones.csv', headers, rows);
            })}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
            title={t('common.csv')}
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">{t('common.csv')}</span>
          </button>
        }
      />

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
        <StatCard
          label={t('investments.currentBalance')}
          value={formatCurrency(lastBalance)}
          icon={TrendingUp}
          tone="positive"
        />
        <StatCard label="Aportes" value={formatCurrency(totalDeposits)} tone="info" />
        <StatCard label="Retiros" value={formatCurrency(totalWithdrawals)} tone="negative" />
        {/* Profit puede ser negativo cuando una inversión pierde (se ingresa
            con signo − en /upload). La card cambia de tono según el signo. */}
        <StatCard
          label={t('investments.profit')}
          value={formatCurrency(totalProfit)}
          tone={totalProfit >= 0 ? 'positive' : 'negative'}
        />
      </div>

      {/* Resumen por responsable — respeta el mismo filtro de fecha activo.
          Se ignoran filas sin responsable. Ordenado por balance desc. */}
      {perResponsibleTotals.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Por Responsable</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {perResponsibleTotals.map((r) => (
              <Card key={r.responsible} className="p-4">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-base font-semibold">{r.responsible}</h3>
                    <p className="text-xs text-muted-foreground">
                      {r.count} {r.count === 1 ? 'inversión' : 'inversiones'}
                    </p>
                  </div>
                  <div className={cn(
                    'text-lg font-bold tabular-nums',
                    r.balance >= 0 ? 'text-emerald-600' : 'text-red-600',
                  )}>
                    {formatCurrency(r.balance)}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="flex flex-col">
                    <span className="text-muted-foreground">Aportes</span>
                    <span className="font-medium text-blue-600 tabular-nums">
                      {formatCurrency(r.deposits)}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground">Retiros</span>
                    <span className="font-medium text-red-600 tabular-nums">
                      {formatCurrency(r.withdrawals)}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-muted-foreground">Profit</span>
                    <span className={cn(
                      'font-medium tabular-nums',
                      r.profit >= 0 ? 'text-emerald-600' : 'text-red-600',
                    )}>
                      {formatCurrency(r.profit)}
                    </span>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      <Card>
        <h2 className="text-lg font-semibold mb-4">{t('investments.history')}</h2>
        <DataTable
          data={tableRows}
          columns={[
            {
              header: '#',
              className: 'w-12',
              accessor: (inv) => (
                <span className="text-muted-foreground tabular-nums">{inv.rowNum}</span>
              ),
            },
            { header: 'Fecha', accessor: (inv) => formatDate(inv.date) },
            { header: 'Concepto', accessor: (inv) => inv.concept || '—' },
            { header: 'Responsable', accessor: (inv) => inv.responsible || '—' },
            {
              header: 'Aporte',
              align: 'right',
              accessor: (inv) => (
                <span className="font-medium text-blue-600">
                  {inv.deposit > 0 ? formatCurrency(inv.deposit) : '—'}
                </span>
              ),
            },
            {
              header: 'Retiro',
              align: 'right',
              accessor: (inv) => (
                <span className="font-medium text-red-600">
                  {inv.withdrawal > 0 ? formatCurrency(inv.withdrawal) : '—'}
                </span>
              ),
            },
            {
              header: 'Profit',
              align: 'right',
              accessor: (inv) => (
                <span className="font-medium text-emerald-600">
                  {inv.profit > 0 ? formatCurrency(inv.profit) : '—'}
                </span>
              ),
            },
            {
              header: 'Balance',
              align: 'right',
              accessor: (inv) => (
                <span className="font-bold">{formatCurrency(balanceMap.get(inv.id) ?? 0)}</span>
              ),
            },
          ]}
          empty={<EmptyState compact title={t('common.noData')} />}
        />
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
