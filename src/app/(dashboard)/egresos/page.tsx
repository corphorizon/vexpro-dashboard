'use client';

import { useState, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Badge } from '@/components/ui/badge';
import { PeriodSelector } from '@/components/period-selector';
import { usePeriod } from '@/lib/period-context';
import { useAuth } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { formatDate, formatDayMonth } from '@/lib/dates';
import type { Expense } from '@/lib/types';
import { downloadCSV } from '@/lib/csv-export';
import { useI18n } from '@/lib/i18n';
import { ConsolidatedBadge } from '@/components/ui/consolidated-badge';
import { ExpenseReference } from '@/components/ui/expense-reference';
import { ExpenseConcept } from '@/components/ui/expense-concept';
import { Search, ArrowUpDown, ArrowDown, ArrowUp, Check, Download, Receipt } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';

type SortState = 'default' | 'desc' | 'asc';

const SortIcon = ({ state }: { state: SortState }) => {
  if (state === 'desc') return <ArrowDown className="w-3.5 h-3.5" />;
  if (state === 'asc') return <ArrowUp className="w-3.5 h-3.5" />;
  return <ArrowUpDown className="w-3.5 h-3.5" />;
};

export default function EgresosPage() {
  const { t } = useI18n();
  const { mode, selectedPeriodId, selectedPeriodIds } = usePeriod();
  const { user } = useAuth();
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);
  const { getPeriodSummary, getConsolidatedSummary, preoperativeExpenses } = useData();

  const [showPreoperativo, setShowPreoperativo] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortState, setSortState] = useState<SortState>('default');

  // Pantalla de SOLO CONSULTA: toda la edición de egresos (crear, editar,
  // marcar pagado, eliminar, propagar egresos fijos) vive en "Carga de Datos".

  // Get summary based on period mode
  const summary = mode === 'consolidated'
    ? getConsolidatedSummary(selectedPeriodIds)
    : getPeriodSummary(selectedPeriodId);

  // Egresos del período seleccionado (lectura directa del data-context).
  const currentExpenses = useMemo<Expense[]>(() => summary?.expenses ?? [], [summary]);

  // Filter and sort expenses
  const filteredExpenses = useMemo(() => {
    let result = [...currentExpenses];

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(e => e.concept.toLowerCase().includes(q));
    }

    // Sort by amount
    if (sortState === 'desc') {
      result.sort((a, b) => b.amount - a.amount);
    } else if (sortState === 'asc') {
      result.sort((a, b) => a.amount - b.amount);
    }

    return result;
  }, [currentExpenses, searchQuery, sortState]);

  // Compute totals from filtered expenses
  const totalExpenses = filteredExpenses.reduce((s, e) => s + e.amount, 0);
  const totalPaid = filteredExpenses.reduce((s, e) => s + e.paid, 0);
  const totalPending = filteredExpenses.reduce((s, e) => s + e.pending, 0);

  // Preoperativo totals
  const preopTotal = preoperativeExpenses.reduce((sum, e) => sum + e.amount, 0);
  const preopPaid = preoperativeExpenses.reduce((sum, e) => sum + e.paid, 0);

  // Cycle sort state
  const cycleSortState = () => {
    setSortState(prev => {
      if (prev === 'default') return 'desc';
      if (prev === 'desc') return 'asc';
      return 'default';
    });
  };

  // Sort icon now extracted as top-level component

  if (!summary) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-8 w-48 bg-muted rounded" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 rounded-xl bg-muted/60" />
          ))}
        </div>
        <div className="h-72 rounded-xl bg-muted/60" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {Modal2FA}
      <PageHeader
        title={t('expenses.title')}
        subtitle={t('expenses.subtitle')}
        icon={Receipt}
        actions={
          <>
            <ConsolidatedBadge count={mode === 'consolidated' ? selectedPeriodIds.length : 1} />
            <button
              onClick={() => setShowPreoperativo(!showPreoperativo)}
              className={`h-9 px-3 rounded-lg border text-sm font-medium transition-colors ${
                showPreoperativo
                  ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                  : 'border-border bg-card hover:bg-muted'
              }`}
            >
              Preoperativo
            </button>
            <button
              onClick={() => verify2FA(() => {
                const exps = showPreoperativo ? preoperativeExpenses : filteredExpenses;
                const headers = showPreoperativo
                  ? ['#', t('expenses.concept'), t('expenses.amount'), t('expenses.paid'), t('expenses.pending')]
                  : ['#', t('expenses.concept'), 'Categoría', t('expenses.date'), t('expenses.amount'), t('expenses.paid'), t('expenses.pending')];
                const rows = exps.map((e, i) => {
                  if (showPreoperativo) {
                    return [i + 1, e.concept, e.amount, e.paid, e.pending] as (string | number)[];
                  }
                  const exp = e as Expense;
                  // La fecha va completa (DD/MM/AAAA) en el CSV: fuera de la
                  // tabla no hay período que dé el año por contexto.
                  return [i + 1, exp.concept, exp.category ?? '', exp.expense_date ? formatDate(exp.expense_date) : '', exp.amount, exp.paid, exp.pending] as (string | number)[];
                });
                downloadCSV(`egresos_${(summary?.period.label || 'export').replace(/\s/g, '_')}.csv`, headers, rows);
              })}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
              title={t('common.csv')}
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">{t('common.csv')}</span>
            </button>
            <PeriodSelector />
          </>
        }
      />

      {showPreoperativo ? (
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('expenses.preoperative')}</h2>
          <div className="overflow-auto max-h-[65vh]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card z-10">
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium w-8">#</th>
                  <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('expenses.concept')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('expenses.amount')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('expenses.paid')}</th>
                  <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('expenses.pending')}</th>
                  <th className="text-center py-2.5 px-3 text-muted-foreground font-medium">{t('expenses.status')}</th>
                </tr>
              </thead>
              <tbody>
                {preoperativeExpenses.map((expense, i) => (
                  <tr key={expense.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                    <td className="py-2.5 px-3 text-muted-foreground">{i + 1}</td>
                    <td className="py-2.5 px-3">{expense.concept}</td>
                    <td className="py-2.5 px-3 text-right font-medium">{formatCurrency(expense.amount)}</td>
                    <td className="py-2.5 px-3 text-right">{formatCurrency(expense.paid)}</td>
                    <td className="py-2.5 px-3 text-right">{formatCurrency(expense.pending)}</td>
                    <td className="py-2.5 px-3 text-center">
                      <Badge variant={expense.pending === 0 ? 'success' : 'warning'}>
                        {expense.pending === 0 ? t('expenses.paidStatus') : t('expenses.pendingStatus')}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold bg-muted/50">
                  <td className="py-3 px-3" colSpan={2}>TOTAL</td>
                  <td className="py-3 px-3 text-right">{formatCurrency(preopTotal)}</td>
                  <td className="py-3 px-3 text-right">{formatCurrency(preopPaid)}</td>
                  <td className="py-3 px-3 text-right">{formatCurrency(preopTotal - preopPaid)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard
              label={t('expenses.title')}
              value={formatCurrency(summary.totalExpenses)}
              icon={Receipt}
              tone="neutral"
            />
            <StatCard
              label={t('expenses.paid')}
              value={formatCurrency(summary.totalExpensesPaid)}
              icon={Check}
              tone="positive"
            />
            <StatCard
              label={t('expenses.pending')}
              value={formatCurrency(summary.totalExpensesPending)}
              tone="warning"
            />
          </div>

          {/* Expenses table */}
          <Card>
            <h2 className="text-lg font-semibold mb-4">{t('expenses.detail')} — {summary.period.label}</h2>

            {/* Search bar and sort */}
            <div className="flex items-center gap-3 mb-4">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={t('expenses.search')}
                  className="w-full pl-9 pr-3 py-2 rounded-lg border border-border text-sm bg-background focus:outline-none focus:ring-2 focus:ring-accent"
                />
              </div>
              <button
                onClick={cycleSortState}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  sortState !== 'default'
                    ? 'border-[var(--color-primary)] text-primary dark:text-accent bg-info/10'
                    : 'border-border hover:bg-muted'
                }`}
                title={
                  sortState === 'default' ? t('expenses.sortDefault') :
                  sortState === 'desc' ? t('expenses.sortDesc') : t('expenses.sortAsc')
                }
              >
                <SortIcon state={sortState} />
                {t('expenses.sortAmount')} {sortState === 'desc' ? t('expenses.sortHighest') : sortState === 'asc' ? t('expenses.sortLowest') : ''}
              </button>
            </div>

            <div className="overflow-auto max-h-[65vh]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-border">
                    <th className="text-left py-2.5 px-3 text-muted-foreground font-medium w-8">#</th>
                    <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">{t('expenses.concept')}</th>
                    <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">Categoría</th>
                    <th className="text-left py-2.5 px-3 text-muted-foreground font-medium">Referencia</th>
                    {/* Fecha opcional (migration-056). Columna angosta con
                        formato DD/MM — el año ya lo da el período — para no
                        ensanchar la tabla en móvil. */}
                    <th className="text-left py-2 px-2 text-muted-foreground font-medium w-16">{t('expenses.date')}</th>
                    <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('expenses.amount')}</th>
                    <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('expenses.paid')}</th>
                    <th className="text-right py-2.5 px-3 text-muted-foreground font-medium">{t('expenses.pending')}</th>
                    <th className="text-center py-2.5 px-3 text-muted-foreground font-medium">{t('expenses.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredExpenses.length === 0 && (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-muted-foreground">
                        {searchQuery ? t('expenses.noResults') : t('expenses.noExpenses')}
                      </td>
                    </tr>
                  )}
                  {filteredExpenses.map((expense, i) => (
                    <tr key={expense.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                      <td className="py-2.5 px-3 text-muted-foreground">{i + 1}</td>
                      {/* Si el egreso vino de una orden de pago, el número de OP
                          es link al detalle de la orden. */}
                      <td className="py-2.5 px-3">
                        <ExpenseConcept concept={expense.concept} paymentOrderId={expense.payment_order_id} />
                      </td>
                      <td className="py-2.5 px-3">
                        {expense.category ? (
                          <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                            {expense.category}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      {/* Referencia del pago: heredada de la orden cuando el
                          egreso nace de una, o cargada a mano en /upload. */}
                      <td className="py-2.5 px-3 max-w-[180px]">
                        <ExpenseReference
                          expenseId={expense.id}
                          reference={expense.reference}
                          attachmentName={expense.attachment_name}
                          hasAttachment={!!expense.attachment_path}
                        />
                      </td>
                      <td className="py-2 px-2 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                        {expense.expense_date ? formatDayMonth(expense.expense_date) : '—'}
                      </td>
                      <td className="py-2.5 px-3 text-right font-medium">{formatCurrency(expense.amount)}</td>
                      <td className="py-2.5 px-3 text-right">{formatCurrency(expense.paid)}</td>
                      <td className="py-2.5 px-3 text-right">{formatCurrency(expense.pending)}</td>
                      <td className="py-2.5 px-3 text-center">
                        <Badge variant={expense.pending === 0 ? 'success' : 'warning'}>
                          {expense.pending === 0 ? t('expenses.paidStatus') : t('expenses.pendingStatus')}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-bold bg-muted/50">
                    {/* 5 = #, Concepto, Categoría, Referencia y Fecha: con 4,
                        los totales caían corridos una columna a la izquierda
                        (el de Monto bajo Fecha — auditoría 2026-08-06). */}
                    <td className="py-3 px-3" colSpan={5}>TOTAL</td>
                    <td className="py-3 px-3 text-right">{formatCurrency(totalExpenses)}</td>
                    <td className="py-3 px-3 text-right">{formatCurrency(totalPaid)}</td>
                    <td className="py-3 px-3 text-right">{formatCurrency(totalPending)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Note: expenses are loaded via "Carga de Datos" section */}
          </Card>
        </>
      )}
    </div>
  );
}
