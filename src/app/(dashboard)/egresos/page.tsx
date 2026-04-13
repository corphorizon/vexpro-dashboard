'use client';

import { useState, useMemo } from 'react';
import { Card } from '@/components/ui/card';
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
import { Search, ArrowUpDown, ArrowDown, ArrowUp, Edit2, Trash2, Check, X, Download } from 'lucide-react';

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
  const { getPeriodSummary, getConsolidatedSummary, preoperativeExpenses, allExpenses } = useData();
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

  // Confirmation dialog
  const [confirmAction, setConfirmAction] = useState<{ message: string; onConfirm: () => void } | null>(null);

  // Success message
  const [successMsg, setSuccessMsg] = useState('');

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  const askConfirmation = (message: string, onConfirm: () => void) => {
    setConfirmAction({ message, onConfirm });
  };

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

  // --- Helpers to mutate expenses ---
  const updateExpensesList = (updater: (prev: Expense[]) => Expense[]) => {
    setExpensesOverrides(prev => ({
      ...prev,
      [periodKey]: updater(prev[periodKey] || currentExpenses),
    }));
  };

  // --- Edit expense ---
  const startEdit = (expense: Expense) => {
    if (!userCanEdit) return;
    setEditingId(expense.id);
    setEditForm({
      concept: expense.concept,
      amount: String(expense.amount),
      paid: String(expense.paid),
      pending: String(expense.pending),
    });
  };

  const saveEdit = () => {
    if (!editingId) return;
    const amt = parseFloat(editForm.amount) || 0;
    const pd = parseFloat(editForm.paid) || 0;
    const pn = parseFloat(editForm.pending) || amt - pd;
    askConfirmation(t('expenses.updateConfirm', { concept: editForm.concept }), () => {
      updateExpensesList(prev =>
        prev.map(e => e.id === editingId
          ? { ...e, concept: editForm.concept, amount: amt, paid: pd, pending: pn }
          : e
        )
      );
      setEditingId(null);
      showSuccess(t('expenses.updatedSuccess'));
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  // --- Delete expense ---
  const handleDelete = (expense: Expense) => {
    if (!userCanDelete) return;
    askConfirmation(t('expenses.deleteConfirm', { concept: expense.concept }), () => {
      updateExpensesList(prev => prev.filter(e => e.id !== expense.id));
      showSuccess(t('expenses.deletedSuccess'));
    });
  };

  if (!summary) return null;

  return (
    <div className="space-y-6">
      {Modal2FA}
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('expenses.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('expenses.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 overflow-x-auto">
          <button
            onClick={() => setShowPreoperativo(!showPreoperativo)}
            className={`px-3 py-2 rounded-lg border text-sm font-medium transition-colors flex-shrink-0 ${
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
              const headers = ['#', t('expenses.concept'), t('expenses.amount'), t('expenses.paid'), t('expenses.pending')];
              const rows = exps.map((e, i) => [i + 1, e.concept, e.amount, e.paid, e.pending] as (string | number)[]);
              downloadCSV(`egresos_${(summary?.period.label || 'export').replace(/\s/g, '_')}.csv`, headers, rows);
            })}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors flex-shrink-0"
            title={t('common.csv')}
          >
            <Download className="w-4 h-4" />
            <span className="hidden sm:inline">{t('common.csv')}</span>
          </button>
          <PeriodSelector />
        </div>
      </div>

      {/* Success message */}
      {successMsg && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 text-sm font-medium" aria-live="polite">
          <Check className="w-4 h-4" />
          {successMsg}
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
            <Card>
              <p className="text-sm text-muted-foreground mb-1">{t('expenses.title')}</p>
              <p className="text-2xl font-bold">{formatCurrency(summary.totalExpenses)}</p>
            </Card>
            <Card>
              <p className="text-sm text-muted-foreground mb-1">{t('expenses.paid')}</p>
              <p className="text-2xl font-bold text-emerald-600">{formatCurrency(summary.totalExpensesPaid)}</p>
            </Card>
            <Card>
              <p className="text-sm text-muted-foreground mb-1">{t('expenses.pending')}</p>
              <p className="text-2xl font-bold text-amber-600">{formatCurrency(summary.totalExpensesPending)}</p>
            </Card>
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
                      <td colSpan={7} className="py-8 text-center text-muted-foreground">
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
                                    className="p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded"
                                    title={t('common.edit')}
                                    aria-label={t('common.edit')}
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                                {userCanDelete && (
                                  <button
                                    onClick={() => handleDelete(expense)}
                                    className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded"
                                    title={t('common.delete')}
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
                    <td className="py-3 px-3" colSpan={2}>TOTAL</td>
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

      {/* Confirmation dialog */}
      {confirmAction && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl shadow-xl p-6 max-w-md mx-4">
            <h3 className="text-lg font-semibold mb-2">{t('upload.confirm')}</h3>
            <p className="text-sm text-muted-foreground mb-6">{confirmAction.message}</p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => { confirmAction.onConfirm(); setConfirmAction(null); }}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
              >
                {t('users.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
