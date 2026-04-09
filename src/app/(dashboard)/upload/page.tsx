'use client';

import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useData } from '@/lib/data-context';
import { useAuth, canAdd, canEdit, canDelete } from '@/lib/auth-context';
import { formatCurrency } from '@/lib/utils';
import { CHANNEL_LABELS, WITHDRAWAL_LABELS } from '@/lib/types';
import type { LiquidityMovement, Investment } from '@/lib/types';
import { Plus, Trash2, Edit2, Check, X, FileSpreadsheet, FileUp, Save, ArrowUpDown, Download } from 'lucide-react';
import { logAction } from '@/lib/audit-log';
import { useI18n } from '@/lib/i18n';
import { FixedExpenseTemplatesPanel } from '@/components/fixed-expense-templates-panel';
import { useApiTotals } from '@/components/realtime-movements-banner';
import {
  isDerivedBrokerPeriod,
  computeDerivedBroker,
} from '@/lib/broker-logic';
import {
  upsertDeposits,
  upsertWithdrawals,
  upsertExpenses,
  upsertOperatingIncome,
  insertLiquidityMovement,
  updateLiquidityMovement,
  deleteLiquidityMovement as deleteLiqMutation,
  insertInvestment,
  updateInvestment,
  deleteInvestment as deleteInvMutation,
  upsertPropFirmSales,
  upsertP2PTransfers,
} from '@/lib/supabase/mutations';

type DataSection = 'depositos' | 'retiros' | 'egresos' | 'ingresos' | 'liquidez' | 'inversiones' | 'documentos';

const SECTION_KEYS: Record<DataSection, string> = {
  depositos: 'upload.deposits',
  retiros: 'upload.withdrawals',
  egresos: 'upload.expenses',
  ingresos: 'upload.operatingIncome',
  liquidez: 'upload.liquidity',
  inversiones: 'upload.investments',
  documentos: 'upload.documents',
};

interface DepositRow { id: string; channel: string; amount: number; }
interface WithdrawalRow { id: string; category: string; amount: number; }
interface ExpenseRow { id: string; concept: string; amount: number; paid: number; pending: number; is_fixed: boolean; }
interface IncomeRow { prop_firm: number; broker_pnl: number; other: number; }
interface DocRow { id: string; filename: string; date: string; description: string; uploaded_by?: string; }

const INITIAL_DEPOSITS: DepositRow[] = [
  { id: 'd1', channel: 'coinsbuy', amount: 0 },
  { id: 'd2', channel: 'fairpay', amount: 0 },
  { id: 'd3', channel: 'unipayment', amount: 0 },
  { id: 'd4', channel: 'other', amount: 0 },
];

const INITIAL_WITHDRAWALS: WithdrawalRow[] = [
  { id: 'w1', category: 'ib_commissions', amount: 0 },
  { id: 'w2', category: 'broker', amount: 0 },
  { id: 'w3', category: 'prop_firm', amount: 0 },
  { id: 'w4', category: 'other', amount: 0 },
];

const MOCK_DOCS: DocRow[] = [
  { id: 'doc1', filename: 'reporte_coinsbuy_mar26.csv', date: '2026-03-15', description: 'Extracto Coinsbuy Marzo' },
  { id: 'doc2', filename: 'facturas_egresos_mar26.pdf', date: '2026-03-14', description: 'Facturas operativas Marzo' },
  { id: 'doc3', filename: 'pl_broker_feb26.xlsx', date: '2026-02-28', description: 'P&L Libro B Febrero' },
];

const STORAGE_KEYS = {
  docs: 'fd_upload_docs',
};

const getPerPeriodKey = (section: string, periodId: string) => `fd_data_${section}_${periodId}`;

function loadFromStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}

function saveToStorage<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    console.warn('Failed to save to localStorage:', key);
  }
}

export default function UploadPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { periods, allDeposits, allWithdrawals, allExpenses, expenseTemplates, allOperatingIncome, allPropFirmSales, allP2PTransfers, getLiquidityData, getInvestmentsData, company, refresh } = useData();
  const isAdmin = user?.role === 'admin';
  const userCanAdd = canAdd(user);
  const userCanEdit = canEdit(user);
  const userCanDelete = canDelete(user);

  const [selectedPeriod, setSelectedPeriod] = useState(periods[periods.length - 1]?.id || '');
  const [section, setSection] = useState<DataSection>('depositos');

  // --- Per-period data helpers (Supabase is source of truth) ---
  const loadDepositsForPeriod = useCallback((periodId: string): DepositRow[] => {
    const periodDeposits = allDeposits.filter(d => d.period_id === periodId);
    return INITIAL_DEPOSITS.map(init => {
      const match = periodDeposits.find(d => d.channel === init.channel);
      return { ...init, amount: match?.amount || 0 };
    });
  }, [allDeposits]);

  const loadWithdrawalsForPeriod = useCallback((periodId: string): WithdrawalRow[] => {
    const periodWithdrawals = allWithdrawals.filter(w => w.period_id === periodId);
    return INITIAL_WITHDRAWALS.map(init => {
      const match = periodWithdrawals.find(w => w.category === init.category);
      return { ...init, amount: match?.amount || 0 };
    });
  }, [allWithdrawals]);

  const loadExpensesForPeriod = useCallback((periodId: string): ExpenseRow[] => {
    const periodExpenses = allExpenses.filter(e => e.period_id === periodId);

    // If the period already has expenses saved, return them as-is
    if (periodExpenses.length > 0) {
      return periodExpenses.map(e => ({
        id: e.id,
        concept: e.concept,
        amount: e.amount,
        paid: e.paid,
        pending: e.pending,
        is_fixed: !!e.is_fixed,
      }));
    }

    // Otherwise, pre-load active fixed expense templates as starting rows
    const activeTemplates = expenseTemplates.filter(tpl => tpl.active);
    return activeTemplates.map((tpl, i) => ({
      id: `tpl-${tpl.id}-${i}`,
      concept: tpl.concept,
      amount: tpl.amount,
      paid: 0,
      pending: tpl.amount,
      is_fixed: true,
    }));
  }, [allExpenses, expenseTemplates]);

  const loadIncomeForPeriod = useCallback((periodId: string): IncomeRow => {
    const periodIncome = allOperatingIncome.find(oi => oi.period_id === periodId);
    return { prop_firm: periodIncome?.prop_firm || 0, broker_pnl: periodIncome?.broker_pnl || 0, other: periodIncome?.other || 0 };
  }, [allOperatingIncome]);

  // Data state (persisted to localStorage per period)
  const lastPeriodId = periods[periods.length - 1]?.id || '';
  const [deposits, setDepositsRaw] = useState<DepositRow[]>(() => loadDepositsForPeriod(lastPeriodId));
  const [withdrawals, setWithdrawalsRaw] = useState<WithdrawalRow[]>(() => loadWithdrawalsForPeriod(lastPeriodId));
  const [expenses, setExpensesRaw] = useState<ExpenseRow[]>(() => loadExpensesForPeriod(lastPeriodId));
  const [income, setIncomeRaw] = useState<IncomeRow>(() => loadIncomeForPeriod(lastPeriodId));
  const [propFirmAmount, setPropFirmAmount] = useState<number>(() => allPropFirmSales.find(p => p.period_id === lastPeriodId)?.amount || 0);
  const [p2pAmount, setP2PAmount] = useState<number>(() => allP2PTransfers.find(p => p.period_id === lastPeriodId)?.amount || 0);
  const [docs, setDocsRaw] = useState<DocRow[]>(() => loadFromStorage(STORAGE_KEYS.docs, MOCK_DOCS));

  // ARCHITECTURE NOTE: We use a ref to track selectedPeriod in setDeposits/setWithdrawals/etc.
  // callbacks. This avoids stale closures without adding selectedPeriod to useCallback deps
  // (which would recreate callbacks on every period change and break ongoing edits).
  // The ref is kept in sync via useEffect below. If refactoring, ensure callbacks always
  // read selectedPeriodRef.current for the storage key, never the state variable directly.
  const selectedPeriodRef = useRef(selectedPeriod);
  useEffect(() => { selectedPeriodRef.current = selectedPeriod; }, [selectedPeriod]);

  // Reload data when period changes
  useEffect(() => {
    setDepositsRaw(loadDepositsForPeriod(selectedPeriod));
    setWithdrawalsRaw(loadWithdrawalsForPeriod(selectedPeriod));
    setExpensesRaw(loadExpensesForPeriod(selectedPeriod));
    setIncomeRaw(loadIncomeForPeriod(selectedPeriod));
    setPropFirmAmount(allPropFirmSales.find(p => p.period_id === selectedPeriod)?.amount || 0);
    setP2PAmount(allP2PTransfers.find(p => p.period_id === selectedPeriod)?.amount || 0);
  }, [selectedPeriod, loadDepositsForPeriod, loadWithdrawalsForPeriod, loadExpensesForPeriod, loadIncomeForPeriod, allPropFirmSales, allP2PTransfers]);

  const setDeposits = useCallback((updater: DepositRow[] | ((prev: DepositRow[]) => DepositRow[])) => {
    setDepositsRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
  }, []);
  const setWithdrawals = useCallback((updater: WithdrawalRow[] | ((prev: WithdrawalRow[]) => WithdrawalRow[])) => {
    setWithdrawalsRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
  }, []);
  const setExpenses = useCallback((updater: ExpenseRow[] | ((prev: ExpenseRow[]) => ExpenseRow[])) => {
    setExpensesRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
  }, []);
  const setIncome = useCallback((updater: IncomeRow | ((prev: IncomeRow) => IncomeRow)) => {
    setIncomeRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
  }, []);
  const setDocs = useCallback((updater: DocRow[] | ((prev: DocRow[]) => DocRow[])) => {
    setDocsRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
  }, []);

  // ── Broker derived-logic helpers ──
  // For April 2026+ the broker amount is no longer entered by hand: it's
  // computed from the Coinsbuy API withdrawals minus the other manual
  // categories, and the input is rendered read-only. Historical periods
  // keep their stored broker value exactly as it was — we NEVER write back
  // over it from this page.
  const currentPeriodObj = useMemo(
    () => periods.find((p) => p.id === selectedPeriod),
    [periods, selectedPeriod]
  );
  const brokerIsDerived = currentPeriodObj
    ? isDerivedBrokerPeriod(currentPeriodObj)
    : false;

  // Date bounds of the current period → feed the API totals hook.
  const { brokerApiFrom, brokerApiTo } = useMemo(() => {
    if (!brokerIsDerived || !currentPeriodObj) {
      return { brokerApiFrom: '', brokerApiTo: '' };
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    const y = currentPeriodObj.year;
    const m = currentPeriodObj.month;
    const lastDay = new Date(y, m, 0).getDate();
    return {
      brokerApiFrom: `${y}-${pad(m)}-01`,
      brokerApiTo: `${y}-${pad(m)}-${pad(lastDay)}`,
    };
  }, [brokerIsDerived, currentPeriodObj]);

  const brokerApiTotals = useApiTotals(brokerApiFrom, brokerApiTo);

  // Live-computed broker. Re-runs as the user edits IB / Prop Firm / Otros.
  const derivedBrokerAmount = useMemo(() => {
    if (!brokerIsDerived) return 0;
    const ib =
      withdrawals.find((w) => w.category === 'ib_commissions')?.amount || 0;
    const pf = withdrawals.find((w) => w.category === 'prop_firm')?.amount || 0;
    const other = withdrawals.find((w) => w.category === 'other')?.amount || 0;
    return computeDerivedBroker({
      apiWithdrawalsTotal: brokerApiTotals.withdrawalsTotal,
      ibCommissions: ib,
      propFirm: pf,
      other,
    });
  }, [brokerIsDerived, withdrawals, brokerApiTotals.withdrawalsTotal]);

  // Liquidez state (from Supabase)
  const [liquidityRows, setLiquidityRowsRaw] = useState<LiquidityMovement[]>(() => [...getLiquidityData()]);
  const setLiquidityRows = useCallback((updater: LiquidityMovement[] | ((prev: LiquidityMovement[]) => LiquidityMovement[])) => {
    setLiquidityRowsRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
  }, []);

  const [liqDateFrom, setLiqDateFrom] = useState('');
  const [liqDateTo, setLiqDateTo] = useState('');
  const [liqPeriodFilter, setLiqPeriodFilter] = useState('todos');
  const [liqSortAsc, setLiqSortAsc] = useState(true);
  const [editingLiqId, setEditingLiqId] = useState<string | null>(null);
  const [editLiq, setEditLiq] = useState({ date: '', user_email: '', mt_account: '', deposit: '', withdrawal: '' });
  const [newLiq, setNewLiq] = useState({ date: '', user_email: '', mt_account: '', deposit: '', withdrawal: '' });

  // Inversiones state (from Supabase)
  const [investmentRows, setInvestmentRowsRaw] = useState<Investment[]>(() => [...getInvestmentsData()]);
  const setInvestmentRows = useCallback((updater: Investment[] | ((prev: Investment[]) => Investment[])) => {
    setInvestmentRowsRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
  }, []);
  const [invDateFrom, setInvDateFrom] = useState('');
  const [invDateTo, setInvDateTo] = useState('');
  const [invPeriodFilter, setInvPeriodFilter] = useState('todos');
  const [invSortAsc, setInvSortAsc] = useState(true);
  const [editingInvId, setEditingInvId] = useState<string | null>(null);
  const [editInv, setEditInv] = useState({ date: '', concept: '', responsible: '', deposit: '', withdrawal: '', profit: '' });
  const [newInv, setNewInv] = useState({ date: '', concept: '', responsible: '', deposit: '', withdrawal: '', profit: '' });

  // UI state
  const [confirmAction, setConfirmAction] = useState<{ type: string; message: string; onConfirm: () => void } | null>(null);
  const [newExpense, setNewExpense] = useState({ concept: '', amount: '', paid: '', pending: '', is_fixed: false });
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [editExpense, setEditExpense] = useState({ concept: '', amount: '', paid: '', pending: '', is_fixed: false });
  const [successMsg, setSuccessMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [savingAll, setSavingAll] = useState(false);

  // Expense concept autocomplete
  const CONCEPT_STORAGE_KEY = 'fd_expense_concepts';
  const [conceptSuggestions, setConceptSuggestions] = useState<string[]>(() => loadFromStorage(CONCEPT_STORAGE_KEY, [] as string[]));
  const [showConceptDropdown, setShowConceptDropdown] = useState(false);
  const conceptInputRef = useRef<HTMLInputElement>(null);

  // Keep concept list updated from all expenses across periods
  useEffect(() => {
    const allConcepts = allExpenses.map(e => e.concept);
    const stored = loadFromStorage<string[]>(CONCEPT_STORAGE_KEY, []);
    const merged = Array.from(new Set([...stored, ...allConcepts])).filter(Boolean).sort();
    setConceptSuggestions(merged);
    saveToStorage(CONCEPT_STORAGE_KEY, merged);
  }, [allExpenses]);

  const addConceptToHistory = (concept: string) => {
    if (!concept) return;
    setConceptSuggestions(prev => {
      const updated = Array.from(new Set([...prev, concept])).sort();
      saveToStorage(CONCEPT_STORAGE_KEY, updated);
      return updated;
    });
  };

  const filteredConcepts = useMemo(() => {
    if (!newExpense.concept) return conceptSuggestions;
    const q = newExpense.concept.toLowerCase();
    return conceptSuggestions.filter(c => c.toLowerCase().includes(q));
  }, [newExpense.concept, conceptSuggestions]);

  const periodLabel = periods.find(p => p.id === selectedPeriod)?.label || '';

  const showSuccess = (msg: string) => {
    setSuccessMsg(msg);
    setTimeout(() => setSuccessMsg(''), 3000);
  };

  const askConfirmation = (message: string, onConfirm: () => void) => {
    setConfirmAction({ type: 'confirm', message, onConfirm });
  };

  // --- Period date range helper ---
  const getPeriodDateRange = (periodId: string): { from: string; to: string } | null => {
    const period = periods.find(p => p.id === periodId);
    if (!period) return null;
    const y = period.year;
    const m = period.month;
    const from = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const to = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { from, to };
  };

  // --- Filtered/sorted liquidity ---
  const filteredLiquidity = useMemo(() => {
    let rows = [...liquidityRows];

    // Period filter
    if (liqPeriodFilter !== 'todos') {
      const range = getPeriodDateRange(liqPeriodFilter);
      if (range) {
        rows = rows.filter(r => r.date >= range.from && r.date <= range.to);
      }
    }

    // Date range filter
    if (liqDateFrom) {
      rows = rows.filter(r => r.date >= liqDateFrom);
    }
    if (liqDateTo) {
      rows = rows.filter(r => r.date <= liqDateTo);
    }

    // Sort
    rows.sort((a, b) => liqSortAsc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));

    return rows;
  }, [liquidityRows, liqDateFrom, liqDateTo, liqPeriodFilter, liqSortAsc]);

  // --- Filtered/sorted investments ---
  const filteredInvestments = useMemo(() => {
    let rows = [...investmentRows];

    // Period filter
    if (invPeriodFilter !== 'todos') {
      const range = getPeriodDateRange(invPeriodFilter);
      if (range) {
        rows = rows.filter(r => r.date >= range.from && r.date <= range.to);
      }
    }

    // Date range filter
    if (invDateFrom) {
      rows = rows.filter(r => r.date >= invDateFrom);
    }
    if (invDateTo) {
      rows = rows.filter(r => r.date <= invDateTo);
    }

    // Sort
    rows.sort((a, b) => invSortAsc ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));

    return rows;
  }, [investmentRows, invDateFrom, invDateTo, invPeriodFilter, invSortAsc]);

  // --- Liquidity helpers ---
  const recalcLiquidityBalances = (rows: LiquidityMovement[]): LiquidityMovement[] => {
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    let balance = 0;
    return sorted.map(r => {
      balance += r.deposit - r.withdrawal;
      return { ...r, balance };
    });
  };

  const addLiquidityRow = () => {
    if (!userCanAdd || !company || !newLiq.date || !newLiq.user_email) return;
    const dep = parseFloat(newLiq.deposit) || 0;
    const wth = parseFloat(newLiq.withdrawal) || 0;
    askConfirmation(`Agregar movimiento de liquidez: Deposito ${formatCurrency(dep)}, Retiro ${formatCurrency(wth)}?`, async () => {
      try {
        await insertLiquidityMovement(company.id, {
          date: newLiq.date,
          user_email: newLiq.user_email || null,
          mt_account: newLiq.mt_account || null,
          deposit: dep,
          withdrawal: wth,
          balance: 0,
        });
        setNewLiq({ date: '', user_email: '', mt_account: '', deposit: '', withdrawal: '' });
        await refresh();
        setLiquidityRowsRaw([...getLiquidityData()]);
        showSuccess(t('upload.liquidityAdded'));
      } catch (err) {
        showSuccess(`Error: ${(err as Error).message}`);
      }
    });
  };

  const startEditLiq = (row: LiquidityMovement) => {
    if (!userCanEdit) return;
    setEditingLiqId(row.id);
    setEditLiq({
      date: row.date,
      user_email: row.user_email || '',
      mt_account: row.mt_account || '',
      deposit: String(row.deposit),
      withdrawal: String(row.withdrawal),
    });
  };

  const saveEditLiq = () => {
    if (!editingLiqId) return;
    const dep = parseFloat(editLiq.deposit) || 0;
    const wth = parseFloat(editLiq.withdrawal) || 0;
    askConfirmation('Actualizar movimiento de liquidez?', async () => {
      try {
        await updateLiquidityMovement(editingLiqId, {
          date: editLiq.date,
          user_email: editLiq.user_email || null,
          mt_account: editLiq.mt_account || null,
          deposit: dep,
          withdrawal: wth,
          balance: 0,
        });
        setEditingLiqId(null);
        await refresh();
        setLiquidityRowsRaw([...getLiquidityData()]);
        showSuccess(t('upload.liquidityUpdated'));
      } catch (err) {
        showSuccess(`Error: ${(err as Error).message}`);
      }
    });
  };

  const deleteLiqRow = (id: string) => {
    if (!userCanDelete) return;
    askConfirmation('Eliminar este movimiento de liquidez?', async () => {
      try {
        await deleteLiqMutation(id);
        await refresh();
        setLiquidityRowsRaw([...getLiquidityData()]);
        showSuccess(t('upload.liquidityDeleted'));
      } catch (err) {
        showSuccess(`Error: ${(err as Error).message}`);
      }
    });
  };

  // --- Investment helpers ---
  const recalcInvestmentBalances = (rows: Investment[]): Investment[] => {
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    let balance = 0;
    return sorted.map(r => {
      balance += r.deposit - r.withdrawal + r.profit;
      return { ...r, balance };
    });
  };

  const addInvestmentRow = () => {
    if (!userCanAdd || !company || !newInv.date) return;
    const dep = parseFloat(newInv.deposit) || 0;
    const wth = parseFloat(newInv.withdrawal) || 0;
    const prf = parseFloat(newInv.profit) || 0;
    askConfirmation(`Agregar movimiento de inversion: Deposito ${formatCurrency(dep)}, Retiro ${formatCurrency(wth)}, Profit ${formatCurrency(prf)}?`, async () => {
      try {
        await insertInvestment(company.id, {
          date: newInv.date,
          concept: newInv.concept || null,
          responsible: newInv.responsible || null,
          deposit: dep,
          withdrawal: wth,
          profit: prf,
          balance: 0,
        });
        setNewInv({ date: '', concept: '', responsible: '', deposit: '', withdrawal: '', profit: '' });
        await refresh();
        setInvestmentRowsRaw([...getInvestmentsData()]);
        showSuccess(t('upload.investmentAdded'));
      } catch (err) {
        showSuccess(`Error: ${(err as Error).message}`);
      }
    });
  };

  const startEditInv = (row: Investment) => {
    if (!userCanEdit) return;
    setEditingInvId(row.id);
    setEditInv({
      date: row.date,
      concept: row.concept || '',
      responsible: row.responsible || '',
      deposit: String(row.deposit),
      withdrawal: String(row.withdrawal),
      profit: String(row.profit),
    });
  };

  const saveEditInv = () => {
    if (!editingInvId) return;
    const dep = parseFloat(editInv.deposit) || 0;
    const wth = parseFloat(editInv.withdrawal) || 0;
    const prf = parseFloat(editInv.profit) || 0;
    askConfirmation('Actualizar movimiento de inversion?', async () => {
      try {
        await updateInvestment(editingInvId, {
          date: editInv.date,
          concept: editInv.concept || null,
          responsible: editInv.responsible || null,
          deposit: dep,
          withdrawal: wth,
          profit: prf,
          balance: 0,
        });
        setEditingInvId(null);
        await refresh();
        setInvestmentRowsRaw([...getInvestmentsData()]);
        showSuccess(t('upload.investmentUpdated'));
      } catch (err) {
        showSuccess(`Error: ${(err as Error).message}`);
      }
    });
  };

  const deleteInvRow = (id: string) => {
    if (!userCanDelete) return;
    askConfirmation('Eliminar este movimiento de inversion?', async () => {
      try {
        await deleteInvMutation(id);
        await refresh();
        setInvestmentRowsRaw([...getInvestmentsData()]);
        showSuccess(t('upload.investmentDeleted'));
      } catch (err) {
        showSuccess(`Error: ${(err as Error).message}`);
      }
    });
  };

  // Deposit handlers
  const updateDeposit = (id: string, amount: number) => {
    if (!userCanAdd || !company) return;
    askConfirmation(`Registrar ${CHANNEL_LABELS[deposits.find(d => d.id === id)?.channel || ''] || ''}: $${amount.toLocaleString()}?`, async () => {
      try {
        const updated = deposits.map(d => d.id === id ? { ...d, amount } : d);
        setDepositsRaw(updated);
        await upsertDeposits(company.id, selectedPeriodRef.current, updated);

        await refresh();
        if (user) logAction(user.id, user.name, 'update', 'deposits', `Deposito ${CHANNEL_LABELS[deposits.find(d => d.id === id)?.channel || ''] || ''}: $${amount.toLocaleString()}`);
        showSuccess(t('upload.depositRegistered'));
      } catch (err) {
        showSuccess(`Error: ${(err as Error).message}`);
      }
    });
  };

  // Withdrawal handlers
  const updateWithdrawal = (id: string, amount: number) => {
    if (!userCanAdd || !company) return;
    askConfirmation(`Registrar ${WITHDRAWAL_LABELS[withdrawals.find(w => w.id === id)?.category || ''] || ''}: $${amount.toLocaleString()}?`, async () => {
      try {
        const updated = withdrawals.map(w => w.id === id ? { ...w, amount } : w);
        setWithdrawalsRaw(updated);
        await upsertWithdrawals(company.id, selectedPeriodRef.current, updated);

        await refresh();
        if (user) logAction(user.id, user.name, 'update', 'withdrawals', `Retiro ${WITHDRAWAL_LABELS[withdrawals.find(w => w.id === id)?.category || ''] || ''}: $${amount.toLocaleString()}`);
        showSuccess(t('upload.withdrawalRegistered'));
      } catch (err) {
        showSuccess(`Error: ${(err as Error).message}`);
      }
    });
  };

  // Expense handlers
  const addExpense = () => {
    if (!userCanAdd || !newExpense.concept || !newExpense.amount) return;
    const amt = parseFloat(newExpense.amount) || 0;
    const pd = parseFloat(newExpense.paid) || 0;
    const pn = parseFloat(newExpense.pending) || amt - pd;
    askConfirmation(`Agregar egreso "${newExpense.concept}" por $${amt.toLocaleString()}?`, () => {
      setExpenses(prev => [...prev, {
        id: `exp-${Date.now()}`,
        concept: newExpense.concept,
        amount: amt,
        paid: pd,
        pending: pn,
        is_fixed: newExpense.is_fixed,
      }]);
      setNewExpense({ concept: '', amount: '', paid: '', pending: '', is_fixed: false });
      addConceptToHistory(newExpense.concept);
      if (user) logAction(user.id, user.name, 'create', 'expenses', `Egreso creado: ${newExpense.concept}, monto: $${amt.toLocaleString()}`);
      showSuccess(t('upload.expenseAdded'));
    });
  };

  const startEditExpense = (exp: ExpenseRow) => {
    if (!userCanEdit) return;
    setEditingExpenseId(exp.id);
    setEditExpense({ concept: exp.concept, amount: String(exp.amount), paid: String(exp.paid), pending: String(exp.pending), is_fixed: !!exp.is_fixed });
  };

  const saveEditExpense = () => {
    if (!editingExpenseId) return;
    const amt = parseFloat(editExpense.amount) || 0;
    const pd = parseFloat(editExpense.paid) || 0;
    const pn = parseFloat(editExpense.pending) || amt - pd;
    askConfirmation(`Actualizar egreso "${editExpense.concept}"?`, () => {
      setExpenses(prev => prev.map(e => e.id === editingExpenseId ? { ...e, concept: editExpense.concept, amount: amt, paid: pd, pending: pn, is_fixed: editExpense.is_fixed } : e));
      setEditingExpenseId(null);
      showSuccess(t('upload.expenseUpdated'));
    });
  };

  const toggleExpenseFixed = (id: string) => {
    if (!userCanEdit) return;
    setExpenses(prev => prev.map(e => e.id === id ? { ...e, is_fixed: !e.is_fixed } : e));
  };

  const deleteExpense = (id: string) => {
    if (!userCanDelete) return;
    const exp = expenses.find(e => e.id === id);
    askConfirmation(`Eliminar egreso "${exp?.concept}"?`, () => {
      setExpenses(prev => prev.filter(e => e.id !== id));
      showSuccess(t('upload.expenseDeleted'));
    });
  };

  // Income handler
  const saveIncome = () => {
    if (!userCanAdd || !company) return;
    askConfirmation(`Registrar ingresos operativos: Broker $${income.broker_pnl.toLocaleString()}, Otros $${income.other.toLocaleString()}?`, async () => {
      try {
        await upsertOperatingIncome(company.id, selectedPeriodRef.current, income);

        await refresh();
        if (user) logAction(user.id, user.name, 'update', 'income', `Ingresos operativos: Broker $${income.broker_pnl.toLocaleString()}, Otros $${income.other.toLocaleString()}`);
        showSuccess(t('upload.incomeSaved'));
      } catch (err) {
        showSuccess(`Error: ${(err as Error).message}`);
      }
    });
  };

  // Save All handler — saves all fields to Supabase
  const saveAll = async () => {
    if (!userCanAdd || !company) return;
    setSavingAll(true);
    const companyId = company.id;
    const periodId = selectedPeriodRef.current;
    try {
      if (section === 'depositos') {
        await upsertDeposits(companyId, periodId, deposits);
        await upsertPropFirmSales(companyId, periodId, propFirmAmount);
        if (user) logAction(user.id, user.name, 'update', 'deposits', `Todos los depositos guardados para ${periodLabel}`);
      } else if (section === 'retiros') {
        await upsertWithdrawals(companyId, periodId, withdrawals);
        await upsertP2PTransfers(companyId, periodId, p2pAmount);
        if (user) logAction(user.id, user.name, 'update', 'withdrawals', `Todos los retiros guardados para ${periodLabel}`);
      } else if (section === 'egresos') {
        await upsertExpenses(companyId, periodId, expenses);
        if (user) logAction(user.id, user.name, 'update', 'expenses', `Todos los egresos guardados para ${periodLabel}`);
      }
      await refresh();
      showSuccess('Todos los datos guardados correctamente');
    } catch (err) {
      showSuccess(`Error al guardar: ${(err as Error).message}`);
    } finally {
      setSavingAll(false);
    }
  };

  // Doc handler
  const handleDocUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    askConfirmation(`Subir documento "${f.name}" al período ${periodLabel}?`, () => {
      setDocs(prev => [{ id: `doc-${Date.now()}`, filename: f.name, date: new Date().toISOString().split('T')[0], description: '', uploaded_by: user?.name || '' }, ...prev]);
      showSuccess(t('upload.documentUploaded'));
    });
    e.target.value = '';
  };

  // Liquidity totals
  const liqTotalDeposits = filteredLiquidity.reduce((s, r) => s + r.deposit, 0);
  const liqTotalWithdrawals = filteredLiquidity.reduce((s, r) => s + r.withdrawal, 0);
  const liqCurrentBalance = filteredLiquidity.length > 0 ? filteredLiquidity[filteredLiquidity.length - 1].balance : 0;

  // Investment totals
  const invTotalDeposits = filteredInvestments.reduce((s, r) => s + r.deposit, 0);
  const invTotalWithdrawals = filteredInvestments.reduce((s, r) => s + r.withdrawal, 0);
  const invTotalProfit = filteredInvestments.reduce((s, r) => s + r.profit, 0);
  const invCurrentBalance = filteredInvestments.length > 0 ? filteredInvestments[filteredInvestments.length - 1].balance : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{t('upload.title')}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t('upload.subtitle')}</p>
      </div>

      {/* Success message */}
      {successMsg && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 text-sm font-medium" aria-live="polite">
          <Check className="w-4 h-4" />
          {successMsg}
        </div>
      )}

      {/* Section tabs */}
      <div className="flex gap-1 border-b border-border pb-0 overflow-x-auto">
        {(Object.keys(SECTION_KEYS) as DataSection[]).map(s => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap ${
              section === s
                ? 'bg-card border border-border border-b-card text-foreground -mb-px'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t(SECTION_KEYS[s])}
          </button>
        ))}
      </div>

      {/* DEPOSITOS */}
      {section === 'depositos' && (
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('upload.deposits')} — {periodLabel}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('upload.channel')}</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium w-48">{t('upload.amountUsd')}</th>
                {userCanAdd && <th className="w-20"></th>}
              </tr>
            </thead>
            <tbody>
              {deposits.map(d => (
                <tr key={d.id} className="border-b border-border/50">
                  <td className="py-3 px-3 font-medium">{CHANNEL_LABELS[d.channel]}</td>
                  <td className="py-3 px-3 text-right">
                    {userCanAdd ? (
                      <input
                        type="number"
                        step="0.01"
                        value={d.amount || ''}
                        onChange={(e) => setDeposits(prev => prev.map(dd => dd.id === d.id ? { ...dd, amount: parseFloat(e.target.value) || 0 } : dd))}
                        className="w-full text-right px-3 py-1.5 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-accent"
                        placeholder="0.00"
                      />
                    ) : (
                      <span className="font-medium">{formatCurrency(d.amount)}</span>
                    )}
                  </td>
                  {userCanAdd && (
                    <td className="py-3 px-3 text-center">
                      <button
                        onClick={() => updateDeposit(d.id, d.amount)}
                        className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 transition-colors"
                        title={t('common.save')}
                      >
                        <Save className="w-4 h-4" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-bold bg-muted/50">
                <td className="py-3 px-3">Total</td>
                <td className="py-3 px-3 text-right text-blue-600">{formatCurrency(deposits.reduce((s, d) => s + d.amount, 0))}</td>
                {userCanAdd && <td></td>}
              </tr>
            </tfoot>
          </table>

          {/* Ventas Prop Firm — separate field, not summed into total */}
          <div className="mt-4 pt-4 border-t border-border">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">Ventas Prop Firm</label>
                <p className="text-xs text-muted-foreground">No se suma al total de depósitos</p>
              </div>
              <div className="flex items-center gap-2">
                {userCanAdd ? (
                  <input
                    type="number"
                    step="0.01"
                    value={propFirmAmount || ''}
                    onChange={(e) => setPropFirmAmount(parseFloat(e.target.value) || 0)}
                    className="w-48 text-right px-3 py-1.5 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-accent"
                    placeholder="0.00"
                  />
                ) : (
                  <span className="font-medium">{formatCurrency(propFirmAmount)}</span>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* RETIROS */}
      {section === 'retiros' && (
        <Card>
          <h2 className="text-lg font-semibold mb-4">{t('upload.withdrawals')} — {periodLabel}</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('upload.category')}</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium w-48">{t('upload.amountUsd')}</th>
                {userCanAdd && <th className="w-20"></th>}
              </tr>
            </thead>
            <tbody>
              {withdrawals.map(w => {
                const isBrokerAutoRow =
                  w.category === 'broker' && brokerIsDerived;
                const displayAmount = isBrokerAutoRow
                  ? derivedBrokerAmount
                  : w.amount;
                return (
                  <tr key={w.id} className="border-b border-border/50">
                    <td className="py-3 px-3 font-medium">
                      {WITHDRAWAL_LABELS[w.category]}
                      {isBrokerAutoRow && (
                        <span className="ml-2 text-[10px] text-emerald-600 dark:text-emerald-400 uppercase tracking-wide">
                          auto
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-3 text-right">
                      {isBrokerAutoRow ? (
                        <div className="flex flex-col items-end">
                          <span className="font-medium">
                            {formatCurrency(derivedBrokerAmount)}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            API − IB − Prop Firm − Otros
                          </span>
                        </div>
                      ) : userCanAdd ? (
                        <input
                          type="number"
                          step="0.01"
                          value={w.amount || ''}
                          onChange={(e) => setWithdrawals(prev => prev.map(ww => ww.id === w.id ? { ...ww, amount: parseFloat(e.target.value) || 0 } : ww))}
                          className="w-full text-right px-3 py-1.5 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-accent"
                          placeholder="0.00"
                        />
                      ) : (
                        <span className="font-medium">{formatCurrency(w.amount)}</span>
                      )}
                    </td>
                    {userCanAdd && (
                      <td className="py-3 px-3 text-center">
                        {isBrokerAutoRow ? (
                          <span
                            className="text-[10px] text-muted-foreground"
                            title="Broker se calcula automáticamente en este período"
                          >
                            —
                          </span>
                        ) : (
                          <button
                            onClick={() => updateWithdrawal(w.id, w.amount)}
                            className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 transition-colors"
                            title={t('common.save')}
                          >
                            <Save className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="font-bold bg-muted/50">
                <td className="py-3 px-3">Total</td>
                <td className="py-3 px-3 text-right text-red-600">
                  {formatCurrency(
                    withdrawals.reduce(
                      (s, w) =>
                        s +
                        (w.category === 'broker' && brokerIsDerived
                          ? derivedBrokerAmount
                          : w.amount),
                      0
                    )
                  )}
                </td>
                {userCanAdd && <td></td>}
              </tr>
              {brokerIsDerived && (
                <tr>
                  <td
                    colSpan={userCanAdd ? 3 : 2}
                    className="py-2 px-3 text-[11px] text-muted-foreground italic"
                  >
                    Desde abril 2026 el campo Broker se calcula automáticamente
                    a partir de los retiros reales de la API de Coinsbuy. Los
                    datos históricos permanecen sin cambios.
                  </td>
                </tr>
              )}
            </tfoot>
          </table>

          {/* Transferencias P2P — separate field, not summed into total */}
          <div className="mt-4 pt-4 border-t border-border">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">Transferencias P2P</label>
                <p className="text-xs text-muted-foreground">No se suma al total de retiros</p>
              </div>
              <div className="flex items-center gap-2">
                {userCanAdd ? (
                  <input
                    type="number"
                    step="0.01"
                    value={p2pAmount || ''}
                    onChange={(e) => setP2PAmount(parseFloat(e.target.value) || 0)}
                    className="w-48 text-right px-3 py-1.5 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-accent"
                    placeholder="0.00"
                  />
                ) : (
                  <span className="font-medium">{formatCurrency(p2pAmount)}</span>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* EGRESOS */}
      {section === 'egresos' && (
        <Card>
          <h2 className="text-base sm:text-lg font-semibold mb-4">Egresos Operativos — {periodLabel}</h2>
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <table className="w-full text-sm min-w-[500px]">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">#</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Concepto</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Monto</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Pagado</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Pendiente</th>
                <th className="text-center py-2 px-3 text-muted-foreground font-medium">Estado</th>
                {(userCanEdit || userCanDelete) && <th className="w-24 text-center py-2 px-3 text-muted-foreground font-medium">Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {expenses.length === 0 && (
                <tr><td colSpan={7} className="py-8 text-center text-muted-foreground">No hay egresos registrados. {userCanAdd && 'Agrega uno abajo.'}</td></tr>
              )}
              {expenses.map((exp, i) => (
                <tr key={exp.id} className="border-b border-border/50 hover:bg-muted/50">
                  {editingExpenseId === exp.id ? (
                    <>
                      <td className="py-2 px-3 text-muted-foreground">{i + 1}</td>
                      <td className="py-2 px-3">
                        <input value={editExpense.concept} onChange={e => setEditExpense(p => ({ ...p, concept: e.target.value }))} className="w-full px-2 py-1 rounded border border-border text-sm" />
                        <label className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground cursor-pointer">
                          <input type="checkbox" checked={editExpense.is_fixed} onChange={e => setEditExpense(p => ({ ...p, is_fixed: e.target.checked }))} className="w-3 h-3" />
                          {t('expenses.fixed')} ({t('expenses.fixedHint')})
                        </label>
                      </td>
                      <td className="py-2 px-3"><input type="number" step="0.01" value={editExpense.amount} onChange={e => setEditExpense(p => ({ ...p, amount: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                      <td className="py-2 px-3"><input type="number" step="0.01" value={editExpense.paid} onChange={e => setEditExpense(p => ({ ...p, paid: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                      <td className="py-2 px-3"><input type="number" step="0.01" value={editExpense.pending} onChange={e => setEditExpense(p => ({ ...p, pending: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                      <td></td>
                      <td className="py-2 px-3 text-center">
                        <div className="flex justify-center gap-1">
                          <button onClick={saveEditExpense} className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 rounded" aria-label={t('common.save')}><Check className="w-4 h-4" /></button>
                          <button onClick={() => setEditingExpenseId(null)} className="p-1 text-muted-foreground hover:bg-muted rounded" aria-label={t('common.cancel')}><X className="w-4 h-4" /></button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="py-2.5 px-3 text-muted-foreground">{i + 1}</td>
                      <td className="py-2.5 px-3">
                        <span className="inline-flex items-center gap-1.5">
                          {exp.concept}
                          {exp.is_fixed && (
                            <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-800 uppercase">
                              {t('expenses.fixedBadge')}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right font-medium">{formatCurrency(exp.amount)}</td>
                      <td className="py-2.5 px-3 text-right">{formatCurrency(exp.paid)}</td>
                      <td className="py-2.5 px-3 text-right">{formatCurrency(exp.pending)}</td>
                      <td className="py-2.5 px-3 text-center">
                        <Badge variant={exp.pending === 0 ? 'success' : 'warning'}>
                          {exp.pending === 0 ? t('upload.paidStatus') : t('upload.pendingStatus')}
                        </Badge>
                      </td>
                      {(userCanEdit || userCanDelete) && (
                        <td className="py-2.5 px-3 text-center">
                          <div className="flex justify-center gap-1">
                            {userCanEdit && (
                              <button onClick={() => startEditExpense(exp)} className="p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded" title={t('common.edit')} aria-label={t('common.edit')}><Edit2 className="w-3.5 h-3.5" /></button>
                            )}
                            {userCanDelete && (
                              <button onClick={() => deleteExpense(exp.id)} className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded" title={t('common.delete')} aria-label={t('common.delete')}><Trash2 className="w-3.5 h-3.5" /></button>
                            )}
                          </div>
                        </td>
                      )}
                    </>
                  )}
                </tr>
              ))}
            </tbody>
            {expenses.length > 0 && (
              <tfoot>
                <tr className="font-bold bg-muted/50">
                  <td className="py-3 px-3" colSpan={2}>Total</td>
                  <td className="py-3 px-3 text-right">{formatCurrency(expenses.reduce((s, e) => s + e.amount, 0))}</td>
                  <td className="py-3 px-3 text-right">{formatCurrency(expenses.reduce((s, e) => s + e.paid, 0))}</td>
                  <td className="py-3 px-3 text-right">{formatCurrency(expenses.reduce((s, e) => s + e.pending, 0))}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            )}
          </table>
          </div>

          {/* Add expense form */}
          {userCanAdd && (
            <div className="mt-4 pt-4 border-t border-border">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Plus className="w-4 h-4" /> {t('upload.addExpense')}</h3>
              <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                <div className="md:col-span-2 relative">
                  <input
                    ref={conceptInputRef}
                    value={newExpense.concept}
                    onChange={e => { setNewExpense(p => ({ ...p, concept: e.target.value })); setShowConceptDropdown(true); }}
                    onFocus={() => setShowConceptDropdown(true)}
                    onBlur={() => setTimeout(() => setShowConceptDropdown(false), 200)}
                    placeholder={t('upload.conceptPlaceholder')}
                    className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    autoComplete="off"
                  />
                  {showConceptDropdown && filteredConcepts.length > 0 && (
                    <div className="absolute z-20 top-full left-0 right-0 mt-1 max-h-48 overflow-auto bg-card border border-border rounded-lg shadow-lg">
                      {filteredConcepts.map(c => (
                        <button
                          key={c}
                          type="button"
                          onMouseDown={(e) => { e.preventDefault(); setNewExpense(p => ({ ...p, concept: c })); setShowConceptDropdown(false); }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <input
                  type="number" step="0.01"
                  value={newExpense.amount}
                  onChange={e => setNewExpense(p => ({ ...p, amount: e.target.value }))}
                  placeholder={t('upload.amountPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <input
                  type="number" step="0.01"
                  value={newExpense.paid}
                  onChange={e => setNewExpense(p => ({ ...p, paid: e.target.value }))}
                  placeholder={t('upload.paidPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <button
                  onClick={addExpense}
                  disabled={!newExpense.concept || !newExpense.amount}
                  className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                >
                  {t('common.add')}
                </button>
              </div>
              <label className="flex items-center gap-2 mt-3 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={newExpense.is_fixed}
                  onChange={e => setNewExpense(p => ({ ...p, is_fixed: e.target.checked }))}
                  className="w-4 h-4"
                />
                <span>
                  <strong>{t('expenses.fixed')}</strong>
                  <span className="text-muted-foreground"> — {t('expenses.fixedHint')}</span>
                </span>
              </label>
            </div>
          )}

          {/* Plantillas de Egresos Fijos */}
          <FixedExpenseTemplatesPanel />
        </Card>
      )}

      {/* INGRESOS OPERATIVOS */}
      {section === 'ingresos' && (
        <Card>
          <h2 className="text-lg font-semibold mb-4">Ingresos Operativos — {periodLabel}</h2>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-muted-foreground mb-1 block">Broker P&L (Libro B)</label>
                {userCanAdd ? (
                  <input
                    type="number" step="0.01"
                    value={income.broker_pnl || ''}
                    onChange={e => setIncome(p => ({ ...p, broker_pnl: parseFloat(e.target.value) || 0 }))}
                    className="w-full px-3 py-2 rounded-lg border border-border text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
                    placeholder="0.00"
                  />
                ) : (
                  <p className="text-lg font-bold">{formatCurrency(income.broker_pnl)}</p>
                )}
              </div>
              <div>
                <label className="text-sm text-muted-foreground mb-1 block">Otros</label>
                {userCanAdd ? (
                  <input
                    type="number" step="0.01"
                    value={income.other || ''}
                    onChange={e => setIncome(p => ({ ...p, other: parseFloat(e.target.value) || 0 }))}
                    className="w-full px-3 py-2 rounded-lg border border-border text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
                    placeholder="0.00"
                  />
                ) : (
                  <p className="text-lg font-bold">{formatCurrency(income.other)}</p>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between pt-4 border-t border-border">
              <div>
                <p className="text-sm text-muted-foreground">Total Ingresos</p>
                <p className="text-xl font-bold">{formatCurrency(income.broker_pnl + income.other)}</p>
              </div>
              {userCanAdd && (
                <button
                  onClick={saveIncome}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  <Save className="w-4 h-4" />
                  Guardar Ingresos
                </button>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* LIQUIDEZ */}
      {section === 'liquidez' && (
        <Card>
          <h2 className="text-lg font-semibold mb-4">Liquidez</h2>

          {/* Filter bar */}
          <div className="flex flex-wrap items-end gap-3 mb-4 pb-4 border-b border-border">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Desde</label>
              <input
                type="date"
                value={liqDateFrom}
                onChange={e => setLiqDateFrom(e.target.value)}
                className="px-3 py-1.5 rounded border border-border text-sm bg-background focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Hasta</label>
              <input
                type="date"
                value={liqDateTo}
                onChange={e => setLiqDateTo(e.target.value)}
                className="px-3 py-1.5 rounded border border-border text-sm bg-background focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Período</label>
              <select
                value={liqPeriodFilter}
                onChange={e => setLiqPeriodFilter(e.target.value)}
                className="px-3 py-1.5 rounded border border-border text-sm bg-background focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="todos">Todos</option>
                {periods.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
            <button
              onClick={() => setLiqSortAsc(prev => !prev)}
              className="flex items-center gap-1 px-3 py-1.5 rounded border border-border text-sm hover:bg-muted transition-colors"
              title={liqSortAsc ? t('upload.dateSortAsc') : t('upload.dateSortDesc')}
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
              {liqSortAsc ? t('upload.dateSortAsc') : t('upload.dateSortDesc')}
            </button>
            {(liqDateFrom || liqDateTo || liqPeriodFilter !== 'todos') && (
              <button
                onClick={() => { setLiqDateFrom(''); setLiqDateTo(''); setLiqPeriodFilter('todos'); }}
                className="px-3 py-1.5 rounded border border-border text-sm text-muted-foreground hover:bg-muted transition-colors"
              >
                {t('audit.clearFilters')}
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('upload.date')}</th>
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('upload.userEmail')}</th>
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('upload.mtAccount')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('upload.deposit')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('upload.withdrawal')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('upload.balance')}</th>
                  {(userCanEdit || userCanDelete) && <th className="w-24 text-center py-2 px-3 text-muted-foreground font-medium">{t('common.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {filteredLiquidity.length === 0 && (
                  <tr><td colSpan={7} className="py-8 text-center text-muted-foreground">{t('upload.noLiquidity')}</td></tr>
                )}
                {filteredLiquidity.map(row => (
                  <tr key={row.id} className="border-b border-border/50 hover:bg-muted/50">
                    {editingLiqId === row.id ? (
                      <>
                        <td className="py-2 px-3"><input type="date" value={editLiq.date} onChange={e => setEditLiq(p => ({ ...p, date: e.target.value }))} className="px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input value={editLiq.user_email} onChange={e => setEditLiq(p => ({ ...p, user_email: e.target.value }))} className="w-full px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input value={editLiq.mt_account} onChange={e => setEditLiq(p => ({ ...p, mt_account: e.target.value }))} className="w-full px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input type="number" step="0.01" value={editLiq.deposit} onChange={e => setEditLiq(p => ({ ...p, deposit: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input type="number" step="0.01" value={editLiq.withdrawal} onChange={e => setEditLiq(p => ({ ...p, withdrawal: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3 text-right text-muted-foreground">{formatCurrency(row.balance)}</td>
                        <td className="py-2 px-3 text-center">
                          <div className="flex justify-center gap-1">
                            <button onClick={saveEditLiq} className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 rounded" aria-label={t('common.save')}><Check className="w-4 h-4" /></button>
                            <button onClick={() => setEditingLiqId(null)} className="p-1 text-muted-foreground hover:bg-muted rounded" aria-label={t('common.cancel')}><X className="w-4 h-4" /></button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="py-2.5 px-3">{row.date}</td>
                        <td className="py-2.5 px-3 text-muted-foreground">{row.user_email || '—'}</td>
                        <td className="py-2.5 px-3 text-muted-foreground">{row.mt_account || '—'}</td>
                        <td className="py-2.5 px-3 text-right font-medium text-emerald-600">{row.deposit > 0 ? formatCurrency(row.deposit) : '—'}</td>
                        <td className="py-2.5 px-3 text-right font-medium text-red-600">{row.withdrawal > 0 ? formatCurrency(row.withdrawal) : '—'}</td>
                        <td className="py-2.5 px-3 text-right font-bold">{formatCurrency(row.balance)}</td>
                        {(userCanEdit || userCanDelete) && (
                          <td className="py-2.5 px-3 text-center">
                            <div className="flex justify-center gap-1">
                              {userCanEdit && (
                                <button onClick={() => startEditLiq(row)} className="p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded" title={t('common.edit')} aria-label={t('common.edit')}><Edit2 className="w-3.5 h-3.5" /></button>
                              )}
                              {userCanDelete && (
                                <button onClick={() => deleteLiqRow(row.id)} className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded" title={t('common.delete')} aria-label={t('common.delete')}><Trash2 className="w-3.5 h-3.5" /></button>
                              )}
                            </div>
                          </td>
                        )}
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
              {filteredLiquidity.length > 0 && (
                <tfoot>
                  <tr className="font-bold bg-muted/50">
                    <td className="py-3 px-3" colSpan={3}>Totales</td>
                    <td className="py-3 px-3 text-right text-emerald-600">{formatCurrency(liqTotalDeposits)}</td>
                    <td className="py-3 px-3 text-right text-red-600">{formatCurrency(liqTotalWithdrawals)}</td>
                    <td className="py-3 px-3 text-right">{formatCurrency(liqCurrentBalance)}</td>
                    {(userCanEdit || userCanDelete) && <td></td>}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Add liquidity form */}
          {userCanAdd && (
            <div className="mt-4 pt-4 border-t border-border">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Plus className="w-4 h-4" /> {t('upload.addMovement')}</h3>
              <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
                <input
                  type="date"
                  value={newLiq.date}
                  onChange={e => setNewLiq(p => ({ ...p, date: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <input
                  value={newLiq.user_email}
                  onChange={e => setNewLiq(p => ({ ...p, user_email: e.target.value }))}
                  placeholder={t('upload.emailPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <input
                  value={newLiq.mt_account}
                  onChange={e => setNewLiq(p => ({ ...p, mt_account: e.target.value }))}
                  placeholder={t('upload.mtAccountPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <input
                  type="number" step="0.01"
                  value={newLiq.deposit}
                  onChange={e => setNewLiq(p => ({ ...p, deposit: e.target.value }))}
                  placeholder={t('upload.depositPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <input
                  type="number" step="0.01"
                  value={newLiq.withdrawal}
                  onChange={e => setNewLiq(p => ({ ...p, withdrawal: e.target.value }))}
                  placeholder={t('upload.withdrawalPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <button
                  onClick={addLiquidityRow}
                  disabled={!newLiq.date || !newLiq.user_email}
                  className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                >
                  {t('common.add')}
                </button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* INVERSIONES */}
      {section === 'inversiones' && (
        <Card>
          <h2 className="text-lg font-semibold mb-4">Inversiones</h2>

          {/* Filter bar */}
          <div className="flex flex-wrap items-end gap-3 mb-4 pb-4 border-b border-border">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Desde</label>
              <input
                type="date"
                value={invDateFrom}
                onChange={e => setInvDateFrom(e.target.value)}
                className="px-3 py-1.5 rounded border border-border text-sm bg-background focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Hasta</label>
              <input
                type="date"
                value={invDateTo}
                onChange={e => setInvDateTo(e.target.value)}
                className="px-3 py-1.5 rounded border border-border text-sm bg-background focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Período</label>
              <select
                value={invPeriodFilter}
                onChange={e => setInvPeriodFilter(e.target.value)}
                className="px-3 py-1.5 rounded border border-border text-sm bg-background focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value="todos">Todos</option>
                {periods.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
            <button
              onClick={() => setInvSortAsc(prev => !prev)}
              className="flex items-center gap-1 px-3 py-1.5 rounded border border-border text-sm hover:bg-muted transition-colors"
              title={invSortAsc ? t('upload.dateSortAsc') : t('upload.dateSortDesc')}
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
              {invSortAsc ? t('upload.dateSortAsc') : t('upload.dateSortDesc')}
            </button>
            {(invDateFrom || invDateTo || invPeriodFilter !== 'todos') && (
              <button
                onClick={() => { setInvDateFrom(''); setInvDateTo(''); setInvPeriodFilter('todos'); }}
                className="px-3 py-1.5 rounded border border-border text-sm text-muted-foreground hover:bg-muted transition-colors"
              >
                {t('audit.clearFilters')}
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('upload.date')}</th>
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('upload.concept')}</th>
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('upload.responsible')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('upload.deposit')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('upload.withdrawal')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('upload.profit')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('upload.balance')}</th>
                  {(userCanEdit || userCanDelete) && <th className="w-24 text-center py-2 px-3 text-muted-foreground font-medium">{t('common.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {filteredInvestments.length === 0 && (
                  <tr><td colSpan={8} className="py-8 text-center text-muted-foreground">{t('upload.noInvestments')}</td></tr>
                )}
                {filteredInvestments.map(row => (
                  <tr key={row.id} className="border-b border-border/50 hover:bg-muted/50">
                    {editingInvId === row.id ? (
                      <>
                        <td className="py-2 px-3"><input type="date" value={editInv.date} onChange={e => setEditInv(p => ({ ...p, date: e.target.value }))} className="px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input value={editInv.concept} onChange={e => setEditInv(p => ({ ...p, concept: e.target.value }))} className="w-full px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input value={editInv.responsible} onChange={e => setEditInv(p => ({ ...p, responsible: e.target.value }))} className="w-full px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input type="number" step="0.01" value={editInv.deposit} onChange={e => setEditInv(p => ({ ...p, deposit: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input type="number" step="0.01" value={editInv.withdrawal} onChange={e => setEditInv(p => ({ ...p, withdrawal: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input type="number" step="0.01" value={editInv.profit} onChange={e => setEditInv(p => ({ ...p, profit: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3 text-right text-muted-foreground">{formatCurrency(row.balance)}</td>
                        <td className="py-2 px-3 text-center">
                          <div className="flex justify-center gap-1">
                            <button onClick={saveEditInv} className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 rounded" aria-label={t('common.save')}><Check className="w-4 h-4" /></button>
                            <button onClick={() => setEditingInvId(null)} className="p-1 text-muted-foreground hover:bg-muted rounded" aria-label={t('common.cancel')}><X className="w-4 h-4" /></button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="py-2.5 px-3">{row.date}</td>
                        <td className="py-2.5 px-3 text-muted-foreground">{row.concept || '—'}</td>
                        <td className="py-2.5 px-3 text-muted-foreground">{row.responsible || '—'}</td>
                        <td className="py-2.5 px-3 text-right font-medium text-emerald-600">{row.deposit > 0 ? formatCurrency(row.deposit) : '—'}</td>
                        <td className="py-2.5 px-3 text-right font-medium text-red-600">{row.withdrawal > 0 ? formatCurrency(row.withdrawal) : '—'}</td>
                        <td className="py-2.5 px-3 text-right font-medium text-blue-600">{row.profit > 0 ? formatCurrency(row.profit) : '—'}</td>
                        <td className="py-2.5 px-3 text-right font-bold">{formatCurrency(row.balance)}</td>
                        {(userCanEdit || userCanDelete) && (
                          <td className="py-2.5 px-3 text-center">
                            <div className="flex justify-center gap-1">
                              {userCanEdit && (
                                <button onClick={() => startEditInv(row)} className="p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded" title={t('common.edit')} aria-label={t('common.edit')}><Edit2 className="w-3.5 h-3.5" /></button>
                              )}
                              {userCanDelete && (
                                <button onClick={() => deleteInvRow(row.id)} className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded" title={t('common.delete')} aria-label={t('common.delete')}><Trash2 className="w-3.5 h-3.5" /></button>
                              )}
                            </div>
                          </td>
                        )}
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
              {filteredInvestments.length > 0 && (
                <tfoot>
                  <tr className="font-bold bg-muted/50">
                    <td className="py-3 px-3" colSpan={3}>Totales</td>
                    <td className="py-3 px-3 text-right text-emerald-600">{formatCurrency(invTotalDeposits)}</td>
                    <td className="py-3 px-3 text-right text-red-600">{formatCurrency(invTotalWithdrawals)}</td>
                    <td className="py-3 px-3 text-right text-blue-600">{formatCurrency(invTotalProfit)}</td>
                    <td className="py-3 px-3 text-right">{formatCurrency(invCurrentBalance)}</td>
                    {(userCanEdit || userCanDelete) && <td></td>}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Add investment form */}
          {userCanAdd && (
            <div className="mt-4 pt-4 border-t border-border">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Plus className="w-4 h-4" /> {t('upload.addMovement')}</h3>
              <div className="grid grid-cols-1 md:grid-cols-7 gap-3">
                <input
                  type="date"
                  value={newInv.date}
                  onChange={e => setNewInv(p => ({ ...p, date: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <input
                  value={newInv.concept}
                  onChange={e => setNewInv(p => ({ ...p, concept: e.target.value }))}
                  placeholder={t('upload.conceptPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <input
                  value={newInv.responsible}
                  onChange={e => setNewInv(p => ({ ...p, responsible: e.target.value }))}
                  placeholder={t('upload.responsiblePlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <input
                  type="number" step="0.01"
                  value={newInv.deposit}
                  onChange={e => setNewInv(p => ({ ...p, deposit: e.target.value }))}
                  placeholder={t('upload.depositPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <input
                  type="number" step="0.01"
                  value={newInv.withdrawal}
                  onChange={e => setNewInv(p => ({ ...p, withdrawal: e.target.value }))}
                  placeholder={t('upload.withdrawalPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <input
                  type="number" step="0.01"
                  value={newInv.profit}
                  onChange={e => setNewInv(p => ({ ...p, profit: e.target.value }))}
                  placeholder={t('upload.profitPlaceholder')}
                  className="w-full px-3 py-2 rounded-lg border border-border text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <button
                  onClick={addInvestmentRow}
                  disabled={!newInv.date}
                  className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                >
                  {t('common.add')}
                </button>
              </div>
            </div>
          )}
        </Card>
      )}

      {/* DOCUMENTOS */}
      {section === 'documentos' && (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Documentos — {periodLabel}</h2>
            {userCanAdd && (
              <button
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
              >
                <FileUp className="w-4 h-4" />
                Subir Documento
              </button>
            )}
            <input ref={fileRef} type="file" onChange={handleDocUpload} className="hidden" />
          </div>

          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <table className="w-full text-sm min-w-[480px]">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Archivo</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Fecha</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium hidden sm:table-cell">Descripcion</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium hidden sm:table-cell">Subido por</th>
                <th className="w-24 text-center py-2 px-3 text-muted-foreground font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {docs.length === 0 && (
                <tr><td colSpan={5} className="py-8 text-center text-muted-foreground">No hay documentos subidos</td></tr>
              )}
              {docs.map(doc => (
                <tr key={doc.id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <FileSpreadsheet className="w-4 h-4 text-emerald-500" />
                      <span className="font-medium">{doc.filename}</span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-muted-foreground">{doc.date}</td>
                  <td className="py-2.5 px-3 text-muted-foreground hidden sm:table-cell">{doc.description || '—'}</td>
                  <td className="py-2.5 px-3 text-muted-foreground hidden sm:table-cell">{doc.uploaded_by || '—'}</td>
                  <td className="py-2.5 px-3 text-center">
                    <div className="flex justify-center gap-1">
                      <button
                        onClick={() => showSuccess(`Descargando ${doc.filename}...`)}
                        className="p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded"
                        title="Descargar"
                        aria-label="Descargar"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                      {userCanDelete && (
                        <button
                          onClick={() => askConfirmation(`Eliminar "${doc.filename}"?`, () => {
                            setDocs(prev => prev.filter(d => d.id !== doc.id));
                            showSuccess(t('upload.investmentDeleted'));
                          })}
                          className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded"
                          aria-label={t('common.delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      )}

      {/* Bottom bar: Period selector + Save All */}
      <div className="sticky bottom-0 z-10 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-3 sm:py-4 bg-background/95 backdrop-blur border-t border-border flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 sm:gap-4">
        <div className="flex items-center gap-2 sm:gap-3">
          <label className="text-xs sm:text-sm font-medium text-muted-foreground whitespace-nowrap">Periodo:</label>
          <select
            value={selectedPeriod}
            onChange={(e) => setSelectedPeriod(e.target.value)}
            className="flex-1 sm:flex-none px-2 sm:px-3 py-2 rounded-lg border border-border bg-card text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent"
          >
            {periods.map(p => (
              <option key={p.id} value={p.id}>{p.label} {p.is_closed ? '(Cerrado)' : ''}</option>
            ))}
          </select>
        </div>
        {userCanAdd && section !== 'documentos' && section !== 'liquidez' && section !== 'inversiones' && section !== 'ingresos' && (
          <button
            onClick={saveAll}
            disabled={savingAll}
            className="flex items-center justify-center gap-2 px-4 sm:px-6 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50 transition-colors shadow-sm"
          >
            <Save className="w-4 h-4" />
            {savingAll ? 'Guardando...' : 'Guardar Todo'}
          </button>
        )}
      </div>

      {/* Confirmation dialog */}
      {confirmAction && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl shadow-xl p-6 max-w-md mx-4">
            <h3 className="text-lg font-semibold mb-2">Confirmar acción</h3>
            <p className="text-sm text-muted-foreground mb-6">{confirmAction.message}</p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmAction(null)}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={() => { confirmAction.onConfirm(); setConfirmAction(null); }}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
