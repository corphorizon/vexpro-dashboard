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
import { Droplets, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import Link from 'next/link';
import { apiFetch } from '@/lib/api-fetch';
import { Scale, AlertTriangle } from 'lucide-react';
import { useRunningBalance } from '@/lib/use-running-balance';

const MONTH_NAMES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const PAGE_SIZE = 50;

export default function LiquidezPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const { getLiquidityData } = useData();
  const [filter, setFilter] = useState('total');
  // Read directly from the data-context on every render — previously the
  // page copied it into local state via `useEffect`, which created a
  // one-tick lag after a mutation and flashed stale rows.
  const liquidityData = useMemo(() => getLiquidityData(), [getLiquidityData]);

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

  // Running balance map — computed on-the-fly from ALL movements sorted by
  // date ascending. We don't trust the stored `balance` column because
  // addLiquidityRow inserts it as 0 (legacy bug). Shared helper in
  // `useRunningBalance` keeps /liquidez, /inversiones, and /balances in sync.
  const balanceMap = useRunningBalance(liquidityData, m => m.deposit - m.withdrawal);

  // Balance Actual = running total at the end of the filtered range.
  // For filter='total' it's the final running balance.
  // For filter='YYYY-MM' it's the balance at the end of that month
  // (includes all prior months + this one).
  const lastBalance = useMemo(() => {
    if (filtered.length === 0) {
      const sorted = [...liquidityData].sort((a, b) => a.date.localeCompare(b.date));
      return sorted.length > 0 ? balanceMap.get(sorted.at(-1)!.id) ?? 0 : 0;
    }
    const sortedFiltered = [...filtered].sort((a, b) => a.date.localeCompare(b.date));
    return balanceMap.get(sortedFiltered.at(-1)!.id) ?? 0;
  }, [filtered, liquidityData, balanceMap]);

  const totalDeposits = filtered.reduce((s, m) => s + m.deposit, 0);
  const totalWithdrawals = filtered.reduce((s, m) => s + m.withdrawal, 0);

  // Pagination — reset to page 0 whenever filter or data changes
  // ── Desglose por cuenta MT (migración 062) ────────────────────────────
  // Se reusa el endpoint de conciliación: ya devuelve el catálogo, el saldo
  // por cuenta y lo pendiente. Un endpoint aparte sería una segunda copia del
  // mismo cálculo, que en este proyecto siempre termina divergiendo.
  const [accounts, setAccounts] = useState<Array<{ id: string; mt_number: string; label: string | null }>>([]);
  const [balancesByAccount, setBalancesByAccount] = useState<Record<string, number>>({});
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/admin/liquidity-reconcile')
      .then((r) => r.json())
      .then((json) => {
        if (cancelled || !json.success) return;
        setAccounts(json.accounts ?? []);
        setBalancesByAccount(json.balancesByAccount ?? {});
        setPendingCount((json.pending ?? []).length);
      })
      .catch(() => { /* el desglose es un extra: si falla, la página sigue */ });
    return () => { cancelled = true; };
  }, []);

  // Solo las cuentas con movimientos: el catálogo tiene 23 y mostrar las
  // vacías llenaría la pantalla de ceros sin información.
  const accountRows = useMemo(() => {
    return accounts
      .map((a) => ({ ...a, balance: balancesByAccount[a.id] ?? 0 }))
      .filter((a) => Math.abs(a.balance) > 0.005)
      .sort((a, b) => b.balance - a.balance);
  }, [accounts, balancesByAccount]);

  const assignedTotal = useMemo(
    () => accountRows.reduce((s, a) => s + a.balance, 0),
    [accountRows],
  );

  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [filter, liquidityData.length]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pagedRows = useMemo(
    () => filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [filtered, page],
  );

  // Número de fila global (respeta la paginación) — DataTable no expone el
  // índice en el accessor, así que se precalcula acá.
  const tableRows = pagedRows.map((mov, i) => ({ ...mov, rowNum: page * PAGE_SIZE + i + 1 }));

  return (
    <div className="space-y-6">
      {Modal2FA}
      <PageHeader
        title={t('liquidity.title')}
        subtitle={t('liquidity.subtitle')}
        icon={Droplets}
        actions={
          <div className="flex items-center gap-2">
          {/* Conciliación: mientras haya movimientos sin cuenta MT, el saldo
              por cuenta no es confiable. El acceso vive acá al lado. */}
          <Link
            href="/liquidez/conciliacion"
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
          >
            <Scale className="w-4 h-4" />
            <span className="hidden sm:inline">Conciliar</span>
          </Link>
          <button
            onClick={() => verify2FA(() => {
              const headers = ['Fecha', 'Concepto', 'Descripción', '+', '-', 'Balance'];
              const rows = filtered.map(m => [m.date, m.user_email || '', m.mt_account || '', m.deposit, m.withdrawal, balanceMap.get(m.id) ?? 0] as (string | number)[]);
              downloadCSV('liquidez.csv', headers, rows);
            })}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
            title={t('common.csv')}
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">{t('common.csv')}</span>
          </button>
          </div>
        }
      />

      {/* Desglose por cuenta MT. Mientras queden movimientos sin atribuir, el
          desglose NO cuadra con el saldo total — decirlo es la diferencia
          entre una tabla útil y una que engaña. */}
      {(accountRows.length > 0 || pendingCount > 0) && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-semibold">Saldo por cuenta MT</h2>
            {pendingCount > 0 && (
              <Link
                href="/liquidez/conciliacion"
                className="inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300 hover:underline"
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                {pendingCount} {pendingCount === 1 ? 'movimiento sin atribuir' : 'movimientos sin atribuir'} — conciliar
              </Link>
            )}
          </div>

          {accountRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Todavía no hay movimientos atribuidos a una cuenta. Empezá por la conciliación.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {accountRows.map((a) => (
                  <div key={a.id} className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground truncate" title={a.label ?? undefined}>
                      {a.mt_number}{a.label ? ` · ${a.label}` : ''}
                    </p>
                    <p className={cn('font-semibold tabular-nums mt-0.5',
                      a.balance >= 0 ? '' : 'text-negative')}>
                      {formatCurrency(a.balance)}
                    </p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-3 tabular-nums">
                Atribuido: {formatCurrency(assignedTotal)} de {formatCurrency(lastBalance)} total
                {Math.abs(assignedTotal - lastBalance) > 0.01 && (
                  <> · <span className="text-amber-700 dark:text-amber-300">
                    faltan {formatCurrency(lastBalance - assignedTotal)} por atribuir
                  </span></>
                )}
              </p>
            </>
          )}
        </Card>
      )}

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
        <StatCard
          label={t('liquidity.currentBalance')}
          value={formatCurrency(lastBalance)}
          icon={Droplets}
          tone="info"
        />
        <StatCard
          label="Ingreso"
          value={formatCurrency(totalDeposits)}
          tone="info"
        />
        {/* "Salida" cubre retiros reales y pérdidas (comisiones, transferencias
            fallidas, etc) en un solo término. */}
        <StatCard
          label="Salida"
          value={formatCurrency(totalWithdrawals)}
          tone="negative"
        />
      </div>

      <Card>
        <h2 className="text-lg font-semibold mb-4">{t('liquidity.history')}</h2>
        <DataTable
          data={tableRows}
          columns={[
            {
              header: '#',
              className: 'w-12',
              accessor: (mov) => (
                <span className="text-muted-foreground tabular-nums">{mov.rowNum}</span>
              ),
            },
            { header: 'Fecha', accessor: (mov) => formatDate(mov.date) },
            {
              header: 'Concepto',
              accessor: (mov) => (
                <span className="block text-xs max-w-[200px] truncate">{mov.user_email || '—'}</span>
              ),
            },
            { header: 'Descripción', accessor: (mov) => mov.mt_account || '—' },
            {
              header: 'Ingreso',
              align: 'right',
              accessor: (mov) => (
                <span className="font-medium text-blue-600">
                  {mov.deposit > 0 ? formatCurrency(mov.deposit) : '—'}
                </span>
              ),
            },
            {
              header: 'Salida',
              align: 'right',
              accessor: (mov) => (
                <span className="font-medium text-red-600">
                  {mov.withdrawal > 0 ? formatCurrency(mov.withdrawal) : '—'}
                </span>
              ),
            },
            {
              header: 'Balance',
              align: 'right',
              accessor: (mov) => (
                <span className="font-bold">{formatCurrency(balanceMap.get(mov.id) ?? 0)}</span>
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
