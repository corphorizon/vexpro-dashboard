'use client';

import { useState, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { Badge } from '@/components/ui/badge';
import { PeriodSelector } from '@/components/period-selector';
import { usePeriod } from '@/lib/period-context';
import { useAuth, canEdit, canDelete } from '@/lib/auth-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import type { Expense } from '@/lib/types';
import { downloadCSV } from '@/lib/csv-export';
import { useI18n } from '@/lib/i18n';
import { upsertExpenses } from '@/lib/supabase/mutations';
import { logAction } from '@/lib/audit-log';
import { useAutoClearMessage } from '@/lib/use-auto-clear-message';
import { useConfirm } from '@/lib/use-confirm';
import { ConsolidatedBadge } from '@/components/ui/consolidated-badge';
import { Search, ArrowUpDown, ArrowDown, ArrowUp, Edit2, Trash2, Check, X, Download, Receipt } from 'lucide-react';
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
  const { getPeriodSummary, getConsolidatedSummary, preoperativeExpenses, company, refresh } = useData();
  const userCanEdit = canEdit(user);
  const userCanDelete = canDelete(user);

  const [showPreoperativo, setShowPreoperativo] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortState, setSortState] = useState<SortState>('default');

  // Expenses local state (initialized from demo data based on period)
  const [expensesOverrides, setExpensesOverrides] = useState<Record<string, Expense[]>>({});

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ concept: '', amount: '', paid: '', pending: '' });

  // Add expense removed — expenses loaded via "Carga de Datos"

  // Shared confirmation dialog — replaces the inline modal + askConfirmation
  // helper. Same semantics, centralized styling.
  const { confirm, Modal: ConfirmModal } = useConfirm();

  // Success message — auto-clears, cleanup-safe (see use-auto-clear-message).
  const [successMsg, showSuccess] = useAutoClearMessage(3000);

  // Get summary based on period mode
  const summary = mode === 'consolidated'
    ? getConsolidatedSummary(selectedPeriodIds)
    : getPeriodSummary(selectedPeriodId);

  // Build a stable key for current period selection
  const periodKey = mode === 'consolidated' ? selectedPeriodIds.join(',') : selectedPeriodId;

  // Get current expenses (with overrides applied)
  const currentExpenses = useMemo(() => {
    if (!summary) return [];
    if (expensesOverrides[periodKey]) return expensesOverrides[periodKey];
    return summary.expenses;
  }, [summary, expensesOverrides, periodKey]);

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

  // Error banner (red) — kept separate from the success (green) one so the
  // user knows at a glance whether a save worked.
  const [errorMsg, showError] = useAutoClearMessage(4500);
  const [saving, setSaving] = useState(false);

  // Editing mutations ONLY make sense for a single period. In consolidated
  // mode we don't know which period the edit belongs to, so we disable the
  // actions in the UI (see `editingDisabled` below).
  const editingDisabled = mode === 'consolidated';

  // Persist `nextList` to Supabase. We run the delete+reinsert helper and
  // then call `refresh()` so the data-context reloads.
  //
  // Fixed 2026-04-22: refresh() used to be awaited inside the try block,
  // which meant a slow context-reload kept the save button spinning even
  // after the DB write succeeded. Now refresh runs in background and the
  // button releases as soon as the real save is done.
  const persistExpenses = async (nextList: Expense[]) => {
    if (!company || !selectedPeriodId) return;
    setSaving(true);
    try {
      await upsertExpenses(company.id, selectedPeriodId, nextList.map(e => ({
        concept: e.concept,
        amount: e.amount,
        paid: e.paid,
        pending: e.pending,
        is_fixed: !!e.is_fixed,
        category: e.category ?? null,
      })));
      // Clear the optimistic override — next read pulls from the refreshed
      // data-context so we never show stale numbers.
      setExpensesOverrides(prev => {
        const next = { ...prev };
        delete next[periodKey];
        return next;
      });
      // Background refresh — the caller doesn't wait on the full context
      // reload. If it fails we log but the save itself already succeeded.
      void refresh().catch((err) => {
        console.warn('[persistExpenses] background refresh failed:', err);
      });
    } finally {
      setSaving(false);
    }
  };

  // --- Edit expense ---
  const startEdit = (expense: Expense) => {
    if (!userCanEdit || editingDisabled) return;
    setEditingId(expense.id);
    setEditForm({
      concept: expense.concept,
      amount: String(expense.amount),
      paid: String(expense.paid),
      pending: String(expense.pending),
    });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    // Explicit NaN/negative guards — parseFloat silently turned "abc" into
    // NaN which then collapsed to 0 and looked like a successful save.
    const amt = parseFloat(editForm.amount);
    const pd = parseFloat(editForm.paid);
    const pnRaw = parseFloat(editForm.pending);
    if (Number.isNaN(amt) || amt < 0) { showError('Monto inválido'); return; }
    if (Number.isNaN(pd) || pd < 0)   { showError('Pagado inválido'); return; }
    const pn = Number.isNaN(pnRaw) ? Math.max(0, amt - pd) : pnRaw;
    if (pn < 0) { showError('Pendiente inválido'); return; }
    if (!editForm.concept.trim()) { showError('Concepto requerido'); return; }

    const nextList = currentExpenses.map(e => e.id === editingId
      ? { ...e, concept: editForm.concept.trim(), amount: amt, paid: pd, pending: pn }
      : e
    );
    setEditingId(null);
    try {
      await persistExpenses(nextList);
      if (user) logAction(user.id, user.name, 'update', 'expenses', `Egreso ${editForm.concept}: $${amt.toLocaleString()}`);
      showSuccess(t('expenses.updatedSuccess'));
    } catch (err) {
      showError(`Error guardando: ${(err as Error).message}`);
    }
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  // --- Delete expense ---
  const handleDelete = (expense: Expense) => {
    if (!userCanDelete || editingDisabled) return;
    confirm(t('expenses.deleteConfirm', { concept: expense.concept }), async () => {
      const nextList = currentExpenses.filter(e => e.id !== expense.id);
      try {
        await persistExpenses(nextList);
        if (user) logAction(user.id, user.name, 'delete', 'expenses', `Egreso eliminado: ${expense.concept}`);
        showSuccess(t('expenses.deletedSuccess'));
      } catch (err) {
        showError(`Error eliminando: ${(err as Error).message}`);
      }
    }, { tone: 'danger', confirmLabel: t('common.delete') });
  };

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
                  : ['#', t('expenses.concept'), 'Categoría', t('expenses.amount'), t('expenses.paid'), t('expenses.pending')];
                const rows = exps.map((e, i) => {
                  if (showPreoperativo) {
                    return [i + 1, e.concept, e.amount, e.paid, e.pending] as (string | number)[];
                  }
                  const exp = e as Expense;
                  return [i + 1, exp.concept, exp.category ?? '', exp.amount, exp.paid, exp.pending] as (string | number)[];
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

      {/* Success / error banners — saving toast stays visible until the
          persist round-trip finishes so the user has feedback on slow
          networks. */}
      {successMsg && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 text-sm font-medium" aria-live="polite">
          <Check className="w-4 h-4" />
          {successMsg}
        </div>
      )}
      {errorMsg && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400 text-sm font-medium" aria-live="assertive">
          <X className="w-4 h-4" />
          {errorMsg}
        </div>
      )}
      {saving && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 text-xs font-medium">
          Guardando…
        </div>
      )}
      {editingDisabled && (userCanEdit || userCanDelete) && (
        <div className="px-3 py-2 rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 text-xs">
          Edición desactivada en modo consolidado — selecciona un solo mes para editar o eliminar egresos.
        </div>
      )}

      {showPreoperativo ? (
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('expenses.preoperative')}</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium w-8">#</th>
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('expenses.concept')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('expenses.amount')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('expenses.paid')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('expenses.pending')}</th>
                  <th className="text-center py-2 px-3 text-muted-foreground font-medium">{t('expenses.status')}</th>
                </tr>
              </thead>
              <tbody>
                {preoperativeExpenses.map((expense, i) => (
                  <tr key={expense.id} className="border-b border-border/50 hover:bg-muted/50">
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
                    ? 'border-[var(--color-primary)] text-[var(--color-primary)] bg-blue-50 dark:bg-blue-950/50'
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

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-3 text-muted-foreground font-medium w-8">#</th>
                    <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('expenses.concept')}</th>
                    <th className="text-left py-2 px-3 text-muted-foreground font-medium">Categoría</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('expenses.amount')}</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('expenses.paid')}</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('expenses.pending')}</th>
                    <th className="text-center py-2 px-3 text-muted-foreground font-medium">{t('expenses.status')}</th>
                    {(userCanEdit || userCanDelete) && (
                      <th className="w-24 text-center py-2 px-3 text-muted-foreground font-medium">{t('expenses.actions')}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filteredExpenses.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-muted-foreground">
                        {searchQuery ? t('expenses.noResults') : t('expenses.noExpenses')}
                      </td>
                    </tr>
                  )}
                  {filteredExpenses.map((expense, i) => (
                    <tr key={expense.id} className="border-b border-border/50 hover:bg-muted/50">
                      {editingId === expense.id ? (
                        <>
                          <td className="py-2 px-3 text-muted-foreground">{i + 1}</td>
                          <td className="py-2 px-3">
                            <input
                              value={editForm.concept}
                              onChange={e => setEditForm(p => ({ ...p, concept: e.target.value }))}
                              className="w-full px-2 py-1 rounded border border-border text-sm"
                            />
                          </td>
                          <td className="py-2 px-3 text-xs text-muted-foreground">
                            {/* Category editing happens in /upload; read-only here */}
                            {expense.category || '—'}
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="number"
                              step="0.01"
                              value={editForm.amount}
                              onChange={e => setEditForm(p => ({ ...p, amount: e.target.value }))}
                              className="w-full text-right px-2 py-1 rounded border border-border text-sm"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="number"
                              step="0.01"
                              value={editForm.paid}
                              onChange={e => setEditForm(p => ({ ...p, paid: e.target.value }))}
                              className="w-full text-right px-2 py-1 rounded border border-border text-sm"
                            />
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="number"
                              step="0.01"
                              value={editForm.pending}
                              onChange={e => setEditForm(p => ({ ...p, pending: e.target.value }))}
                              className="w-full text-right px-2 py-1 rounded border border-border text-sm"
                            />
                          </td>
                          <td></td>
                          <td className="py-2 px-3 text-center">
                            <div className="flex justify-center gap-1">
                              <button onClick={saveEdit} className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 rounded" aria-label={t('common.save')}><Check className="w-4 h-4" /></button>
                              <button onClick={cancelEdit} className="p-1 text-muted-foreground hover:bg-muted rounded" aria-label={t('common.cancel')}><X className="w-4 h-4" /></button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="py-2.5 px-3 text-muted-foreground">{i + 1}</td>
                          <td className="py-2.5 px-3">{expense.concept}</td>
                          <td className="py-2.5 px-3">
                            {expense.category ? (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                                {expense.category}
                              </span>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-medium">{formatCurrency(expense.amount)}</td>
                          <td className="py-2.5 px-3 text-right">{formatCurrency(expense.paid)}</td>
                          <td className="py-2.5 px-3 text-right">{formatCurrency(expense.pending)}</td>
                          <td className="py-2.5 px-3 text-center">
                            <Badge variant={expense.pending === 0 ? 'success' : 'warning'}>
                              {expense.pending === 0 ? t('expenses.paidStatus') : t('expenses.pendingStatus')}
                            </Badge>
                          </td>
                          {(userCanEdit || userCanDelete) && (
                            <td className="py-2.5 px-3 text-center">
                              <div className="flex justify-center gap-1">
                                {userCanEdit && (
                                  <button
                                    onClick={() => startEdit(expense)}
                                    disabled={editingDisabled}
                                    className="p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                                    title={editingDisabled ? 'Selecciona un solo mes' : t('common.edit')}
                                    aria-label={t('common.edit')}
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                {userCanDelete && (
                                  <button
                                    onClick={() => handleDelete(expense)}
                                    disabled={editingDisabled}
                                    className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                                    title={editingDisabled ? 'Selecciona un solo mes' : t('common.delete')}
                                    aria-label={t('common.delete')}
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </td>
                          )}
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-bold bg-muted/50">
                    <td className="py-3 px-3" colSpan={3}>TOTAL</td>
                    <td className="py-3 px-3 text-right">{formatCurrency(totalExpenses)}</td>
                    <td className="py-3 px-3 text-right">{formatCurrency(totalPaid)}</td>
                    <td className="py-3 px-3 text-right">{formatCurrency(totalPending)}</td>
                    <td></td>
                    {(userCanEdit || userCanDelete) && <td></td>}
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Note: expenses are loaded via "Carga de Datos" section */}
          </Card>
        </>
      )}

      {ConfirmModal}
    </div>
  );
}
