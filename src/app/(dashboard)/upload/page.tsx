'use client';

import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useData } from '@/lib/data-context';
import { useAuth, canAdd, canEdit, canDelete } from '@/lib/auth-context';
import { formatCurrency } from '@/lib/utils';
import { CHANNEL_LABELS, WITHDRAWAL_LABELS } from '@/lib/types';
import type { LiquidityMovement, Investment } from '@/lib/types';
import { Plus, Trash2, Edit2, Check, X, FileSpreadsheet, FileUp, Save, ArrowUpDown, Download, ChevronLeft, ChevronRight, GripVertical } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// ─── Pagination ──────────────────────────────────────────────────────────
// Shared cap across all three data-entry tables (Egresos, Liquidez, Inv.).
const PAGE_SIZE = 25;

function PaginationControls({
  page, totalPages, totalItems, onChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  onChange: (next: number) => void;
}) {
  // Hidden for small datasets — the spec says "25 or fewer → single page".
  if (totalItems <= PAGE_SIZE) return null;
  const from = page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, totalItems);
  return (
    <div className="flex items-center justify-between mt-3 text-sm">
      <span className="text-muted-foreground">
        {from}–{to} de {totalItems}
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onChange(Math.max(0, page - 1))}
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
          onClick={() => onChange(Math.min(totalPages - 1, page + 1))}
          disabled={page >= totalPages - 1}
          className="p-1.5 rounded border border-border hover:bg-muted disabled:opacity-40 disabled:pointer-events-none"
          aria-label="Página siguiente"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
import { logAction } from '@/lib/audit-log';
import { useI18n } from '@/lib/i18n';
import { useConfirm } from '@/lib/use-confirm';
import { FixedExpenseTemplatesPanel } from '@/components/fixed-expense-templates-panel';
import { useApiTotals } from '@/components/realtime-movements-banner';
import { useToasts } from '@/components/ui/toast';
import {
  isDerivedBrokerPeriod,
  computeDerivedBroker,
} from '@/lib/broker-logic';
import {
  parseAmount,
  computeExpensePending,
} from '@/lib/upload-calculations';
import {
  upsertDeposits,
  upsertWithdrawals,
  upsertExpenses,
  updateExpenseOrder,
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
import * as Sentry from '@sentry/nextjs';

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
interface ExpenseRow { id: string; concept: string; amount: number; paid: number; pending: number; is_fixed: boolean; category: string | null; }

// ─── Sortable row wrapper (drag-and-drop reorder) ─────────────────────────
// Wraps each expense <tr> so it can be dragged via the leading handle
// column. We use @dnd-kit/sortable — the drag works by keyboard too
// (tab to the handle, space to pick up, arrow keys to move, space to
// drop), which keeps the feature accessible.
//
// Keep this component outside the main page so React doesn't recreate
// the hook instances on every parent render.
function SortableExpenseRow({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    // Keep the dragged row above its neighbours so the shadow reads right.
    zIndex: isDragging ? 10 : undefined,
    position: isDragging ? 'relative' : undefined,
  };

  return (
    <tr ref={setNodeRef} style={style} className="border-b border-border/50 hover:bg-muted/50">
      <td
        className={`py-2.5 px-2 text-muted-foreground ${
          disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-grab active:cursor-grabbing'
        } touch-none select-none`}
        {...(disabled ? {} : attributes)}
        {...(disabled ? {} : listeners)}
        aria-label={disabled ? 'Termina de editar para mover' : 'Arrastrar para reordenar'}
        title={disabled ? 'Termina de editar para mover' : 'Arrastrar para reordenar'}
      >
        <GripVertical className="w-4 h-4" />
      </td>
      {children}
    </tr>
  );
}
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

/** Small "Guardado hace Xs" indicator. Re-renders itself every 10 s so
 *  the label stays fresh without the parent owning a clock. Drops out
 *  silently after 5 min — at that point the user already moved on. */
function SavedRecentlyBadge({ at }: { at: Date }) {
  // secs se calcula DENTRO del effect (no en render): la regla react-compiler
  // prohíbe llamar funciones impuras como Date.now() durante el render.
  // `atMs` es estable (getTime es puro), así el effect corre una sola vez.
  const atMs = at.getTime();
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const update = () => setSecs(Math.floor((Date.now() - atMs) / 1000));
    update();
    const id = setInterval(update, 10_000);
    return () => clearInterval(id);
  }, [atMs]);
  if (secs > 300) return null; // > 5 min — stop bragging.
  const label =
    secs < 5
      ? 'Guardado'
      : secs < 60
        ? `Guardado hace ${secs} s`
        : `Guardado hace ${Math.floor(secs / 60)} min`;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 whitespace-nowrap"
      aria-live="polite"
      title="Última vez que se guardó esta sección"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
      {label}
    </span>
  );
}

export default function UploadPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { periods, allDeposits, allWithdrawals, allExpenses, expenseTemplates, allOperatingIncome, allPropFirmSales, allP2PTransfers, getLiquidityData, getInvestmentsData, company, refresh, refreshSections } = useData();
  const isAdmin = user?.role === 'admin';
  const userCanAdd = canAdd(user);
  const userCanEdit = canEdit(user);
  const userCanDelete = canDelete(user);

  const [selectedPeriod, setSelectedPeriod] = useState(periods[periods.length - 1]?.id || '');
  const [section, setSection] = useState<DataSection>('depositos');

  // ── Dirty-state tracker for "Guardar Todo" sections ───────────────────
  // Egresos / Depósitos / Retiros / Ingresos keep unsaved changes in local
  // state until the user clicks "Guardar Todo". Users kept losing rows
  // because there was no visual signal that an action (add/edit/delete)
  // had not been persisted yet. This ref-based flag drives:
  //   · a banner shown next to the save button,
  //   · a guard that prevents the silent refresh sync-effect from wiping
  //     unsaved local state.
  // Dirty tracking — multi-section.
  //
  // Originally `dirtySection: DataSection | null` (one slot). That had a
  // CRITICAL bug Kevin reported on 2026-05-13: if `saveAll('egresos')`
  // failed mid-batch, the catch surfaced a toast but never cleared the
  // dirty flag. The sync effect at line ~360 — guarded by
  // `if (dirtySection) return` — then refused to re-hydrate ANY section
  // (deposits, withdrawals, ingresos) from the DataProvider, since they
  // all shared the same flag. A failed save in Egresos froze the entire
  // page until a hard reload.
  //
  // Now: a Set of dirty sections. Each section's sync is gated only by
  // its OWN dirty entry, so a failure in Egresos doesn't block Deposits
  // from refreshing on period change. And on save success we clear ONLY
  // the section that was saved — preserving any cross-section work-in-
  // progress the user may have started before clicking "Guardar todo".
  const [dirtySections, setDirtySectionsRaw] = useState<Set<DataSection>>(() => new Set());
  const markDirty = useCallback((s: DataSection) => {
    setDirtySectionsRaw(prev => {
      if (prev.has(s)) return prev;
      const next = new Set(prev);
      next.add(s);
      return next;
    });
  }, []);
  const clearDirty = useCallback((s: DataSection) => {
    setDirtySectionsRaw(prev => {
      if (!prev.has(s)) return prev;
      const next = new Set(prev);
      next.delete(s);
      return next;
    });
  }, []);
  // Back-compat: most of the existing code only checks "is anything
  // dirty?" — keep a derived helper so we don't have to touch every site.
  const hasDirty = dirtySections.size > 0;

  // Auto-pick the latest period once `periods` loads asynchronously. On a
  // cold page hit the DataProvider is still fetching → `periods` is empty
  // → `selectedPeriod` gets initialized as ''. Without this effect the
  // <select> stays empty forever and the tables render blank, which the
  // user perceives as "loading never ends".
  useEffect(() => {
    if (!selectedPeriod && periods.length > 0) {
      setSelectedPeriod(periods[periods.length - 1].id);
    }
  }, [periods, selectedPeriod]);

  // --- Per-period data helpers (Supabase is source of truth) ---
  const loadDepositsForPeriod = useCallback((periodId: string): DepositRow[] => {
    const periodDeposits = allDeposits.filter(d => d.period_id === periodId);
    return INITIAL_DEPOSITS.map(init => {
      const match = periodDeposits.find(d => d.channel === init.channel);
      return { ...init, amount: match?.amount || 0 };
    });
  }, [allDeposits]);

  const loadWithdrawalsForPeriod = useCallback((periodId: string): WithdrawalRow[] => {
    // Aggregate rows are the ones without a description.
    const periodWithdrawals = allWithdrawals.filter(w => w.period_id === periodId && !w.description);
    return INITIAL_WITHDRAWALS.map(init => {
      const match = periodWithdrawals.find(w => w.category === init.category);
      return { ...init, amount: match?.amount || 0 };
    });
  }, [allWithdrawals]);

  // Extra manual withdrawal entries — rows with a description in DB.
  // Shown below the fixed 4 aggregates so users can register individual
  // manual withdrawals alongside what the APIs report.
  interface ExtraWithdrawalRow {
    id: string;
    category: 'ib_commissions' | 'broker' | 'prop_firm' | 'other';
    amount: number;
    description: string;
  }
  const loadWithdrawalExtrasForPeriod = useCallback((periodId: string): ExtraWithdrawalRow[] => {
    return allWithdrawals
      .filter(w => w.period_id === periodId && !!w.description)
      .map(w => ({ id: w.id, category: w.category, amount: w.amount, description: w.description || '' }));
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
        category: e.category ?? null,
      }));
    }

    // Otherwise, pre-load active fixed expense templates as starting rows.
    //
    // Kevin (2026-06-06): los gastos fijos al pasar al mes siguiente deben
    // CONSERVAR la categoría que tenían el mes anterior — antes se cargaban
    // con category=null y había que re-asignar manualmente cada mes.
    //
    // Estrategia sin migration: para cada template, buscar el expense más
    // reciente con el MISMO concept (en cualquier período anterior) y
    // heredar su category. Cadena natural: si en mayo asignaste
    // "Office Rent - Mexico" → "Operating Expense", junio la hereda
    // automáticamente; si en junio la cambias a "Rent", julio hereda esa.
    const conceptCategoryMap = new Map<string, string | null>();
    const sortedExpenses = [...allExpenses].sort((a, b) => {
      const pa = periods.find(p => p.id === a.period_id);
      const pb = periods.find(p => p.id === b.period_id);
      if (!pa || !pb) return 0;
      if (pa.year !== pb.year) return pb.year - pa.year;
      return pb.month - pa.month;
    });
    for (const e of sortedExpenses) {
      if (!conceptCategoryMap.has(e.concept)) {
        conceptCategoryMap.set(e.concept, e.category ?? null);
      }
    }

    const activeTemplates = expenseTemplates.filter(tpl => tpl.active);
    return activeTemplates.map((tpl, i) => ({
      id: `tpl-${tpl.id}-${i}`,
      concept: tpl.concept,
      amount: tpl.amount,
      paid: 0,
      pending: tpl.amount,
      is_fixed: true,
      category: conceptCategoryMap.get(tpl.concept) ?? null,
    }));
  }, [allExpenses, expenseTemplates, periods]);

  const loadIncomeForPeriod = useCallback((periodId: string): IncomeRow => {
    const periodIncome = allOperatingIncome.find(oi => oi.period_id === periodId);
    return { prop_firm: periodIncome?.prop_firm || 0, broker_pnl: periodIncome?.broker_pnl || 0, other: periodIncome?.other || 0 };
  }, [allOperatingIncome]);

  // Data state (persisted to localStorage per period)
  const lastPeriodId = periods[periods.length - 1]?.id || '';
  const [deposits, setDepositsRaw] = useState<DepositRow[]>(() => loadDepositsForPeriod(lastPeriodId));
  const [withdrawals, setWithdrawalsRaw] = useState<WithdrawalRow[]>(() => loadWithdrawalsForPeriod(lastPeriodId));
  const [withdrawalExtras, setWithdrawalExtras] = useState<ExtraWithdrawalRow[]>(() => loadWithdrawalExtrasForPeriod(lastPeriodId));
  const [newExtraWithdrawal, setNewExtraWithdrawal] = useState<{ category: 'ib_commissions' | 'broker' | 'prop_firm' | 'other'; amount: string; description: string }>({
    category: 'broker',
    amount: '',
    description: '',
  });
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

  // Reload data when the PERIOD changes. Intentionally depends only on
  // `selectedPeriod` (and `dirtySection`). Earlier this effect also listed
  // the `loadXForPeriod` callbacks + raw `allExpenses` etc. as deps — but
  // those references change on every silent refresh of the DataProvider.
  // That turned any background refresh into a surprise reset of local
  // state: the user adds an egreso row, a refresh fires for an unrelated
  // reason, this effect re-runs, and the unsaved row disappears.
  //
  // Now we re-sync local state only when the user explicitly switches
  // period (or when leaving a dirty section — the save handler resets
  // `dirtySection` to null, which triggers a clean re-sync from the new
  // DB state).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Per-section guard. A failed save in one tab doesn't block re-sync
    // in the others (see dirtySections rationale above). Each block also
    // independently re-syncs when the user switches period.
    if (!dirtySections.has('depositos')) {
      setDepositsRaw(loadDepositsForPeriod(selectedPeriod));
    }
    if (!dirtySections.has('retiros')) {
      setWithdrawalsRaw(loadWithdrawalsForPeriod(selectedPeriod));
      setWithdrawalExtras(loadWithdrawalExtrasForPeriod(selectedPeriod));
      // P2P transfer lives in the Retiros tab — share its dirty bucket.
      setP2PAmount(allP2PTransfers.find(p => p.period_id === selectedPeriod)?.amount || 0);
    }
    if (!dirtySections.has('egresos')) {
      setExpensesRaw(loadExpensesForPeriod(selectedPeriod));
    }
    if (!dirtySections.has('ingresos')) {
      setIncomeRaw(loadIncomeForPeriod(selectedPeriod));
      // Prop Firm sales sit in the Ingresos tab — share its dirty bucket.
      setPropFirmAmount(allPropFirmSales.find(p => p.period_id === selectedPeriod)?.amount || 0);
    }
  }, [selectedPeriod, dirtySections]);

  // Wrapped setters — every user-driven mutation also flags the section as
  // dirty. The sync effect bypasses these wrappers and calls the Raw
  // setters directly, so the initial hydration doesn't flip the flag.
  const setDeposits = useCallback((updater: DepositRow[] | ((prev: DepositRow[]) => DepositRow[])) => {
    setDepositsRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
    markDirty('depositos');
  }, [markDirty]);
  const setWithdrawals = useCallback((updater: WithdrawalRow[] | ((prev: WithdrawalRow[]) => WithdrawalRow[])) => {
    setWithdrawalsRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
    markDirty('retiros');
  }, [markDirty]);
  const setExpenses = useCallback((updater: ExpenseRow[] | ((prev: ExpenseRow[]) => ExpenseRow[])) => {
    setExpensesRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
    markDirty('egresos');
  }, [markDirty]);
  const setIncome = useCallback((updater: IncomeRow | ((prev: IncomeRow) => IncomeRow)) => {
    setIncomeRaw(prev => typeof updater === 'function' ? updater(prev) : updater);
    markDirty('ingresos');
  }, [markDirty]);
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

  // Kevin (2026-06-06): pasamos default_wallet_id para que el cálculo
  // del "broker derivado" considere SOLO la wallet principal (en Vex Pro
  // = 1079 VexPro Main Wallet) y no incluya retiros de wallets ajenas
  // (Exura Prime, AP MARKETS, Savings) que también aparecen en
  // api_transactions del tenant. Sin este filtro el broker se inflaba.
  const brokerApiTotals = useApiTotals(
    brokerApiFrom,
    brokerApiTo,
    company?.default_wallet_id ?? '',
  );

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

  // Stiven (2026-06-19): Bug "tabs vacíos en Carga de Datos".
  //
  // El useState lazy-init de `liquidityRows` / `investmentRows` solo corre en
  // el MOUNT. Si DataContext aún estaba cargando cuando esta página renderizó,
  // los arrays quedaban en [] para siempre — la tabla salía vacía aunque la
  // BD tuviera datos. Cualquier edit/save subsiguiente sí hacía
  // `setInvestmentRowsRaw([...getInvestmentsData()])`, así que la página
  // "se arreglaba sola" con una interacción — eso explica la intermitencia.
  //
  // Solución: sincronizar desde DataContext con un useEffect cuando llegue
  // data nueva, PERO solo si el usuario no está editando una fila (para no
  // pisarle el formulario en medio de una edición).
  const investmentsFromCtx = getInvestmentsData();
  useEffect(() => {
    if (editingInvId === null) {
      setInvestmentRowsRaw([...investmentsFromCtx]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [investmentsFromCtx.length, editingInvId]);

  const liquidityFromCtx = getLiquidityData();
  useEffect(() => {
    if (editingLiqId === null) {
      setLiquidityRowsRaw([...liquidityFromCtx]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liquidityFromCtx.length, editingLiqId]);

  // UI state — shared confirmation dialog for destructive deletes.
  const { confirm, Modal: ConfirmModal } = useConfirm();
  const [newExpense, setNewExpense] = useState({ concept: '', amount: '', paid: '', pending: '', is_fixed: false, category: '' });
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [editExpense, setEditExpense] = useState({ concept: '', amount: '', paid: '', pending: '', is_fixed: false, category: '' });
  const fileRef = useRef<HTMLInputElement>(null);
  const [savingAll, setSavingAll] = useState(false);

  // Per-module "saving" locks for Liquidez / Inversiones row handlers.
  // We used to fire-and-forget the mutation inside an IIFE with no local
  // state — a network hang left the UI frozen (form not clearing, row
  // stuck in edit mode) without any error surfaced to the user. Now every
  // mutation goes through `withRowTimeout` (10s hard cap) + a boolean
  // lock that disables the relevant buttons while in-flight.
  const [savingLiq, setSavingLiq] = useState(false);
  const [savingInv, setSavingInv] = useState(false);

  // Per-row saving locks for Depósitos / Retiros inline edits.
  // Kevin reported (2026-05-13) that updateDeposit/updateWithdrawal had no
  // visible feedback while the upsert was in flight — users assumed the
  // save hadn't happened and hard-refreshed mid-write. The Set keys are
  // the deposit-row / withdrawal-row IDs, so we can disable the input
  // for just the row being saved (the rest of the table stays editable).
  const [savingDepositIds, setSavingDepositIds] = useState<Set<string>>(() => new Set());
  const [savingWithdrawalIds, setSavingWithdrawalIds] = useState<Set<string>>(() => new Set());

  // beforeunload guard — warn the user before they close the tab / hit
  // back / hard-reload while there are unsaved edits in the local state.
  // The browser shows its own native prompt; we only need to set
  // `returnValue` on the event (modern browsers ignore the custom string
  // and show their own copy). The handler is detached when nothing is
  // dirty so the user can leave freely in the common case.
  useEffect(() => {
    if (!hasDirty && !savingAll) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Required for Chrome — must set returnValue to a truthy string.
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasDirty, savingAll]);

  // ── Auto-save (debounced) ─────────────────────────────────────────────
  //
  // Kevin (2026-06-07): "sería bueno que cada vez que haga un cambio vaya
  // guardando así evitamos eso" — after losing the "Guardar Todo" race
  // twice in a row.
  //
  // Design:
  //   · Watch the dirty set + current section. When the current section
  //     is dirty, start a 3-second debounce timer.
  //   · Any further edit restarts the timer (debounce). So a user typing
  //     continuously triggers ONE save, not one-per-keystroke.
  //   · If a save is already in flight (`savingAll`), the timer is held
  //     off — the existing save will flush whatever's dirty when it
  //     finishes; if edits happened during it, this effect re-fires.
  //   · Cleanup on unmount or section change so we don't fire a save for
  //     a section that isn't visible.
  //
  // The "Guardar Todo" button stays — explicit save is still available
  // for users who want it. Autosave is additive: the button just becomes
  // the manual override.
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const AUTOSAVE_DEBOUNCE_MS = 3000;

  useEffect(() => {
    // BUG-03: autosave persiste las secciones batch con cambios sin guardar,
    // aunque el usuario haya cambiado de pestaña. saveAll guarda la unión de
    // secciones dirty (ver targets).
    //
    // Exclusiones:
    //   · egresos → persiste por-acción (persistExpenses); su dirty transitorio
    //     es un mutex, no un pendiente.
    //   · ingresos (Kevin 2026-07-13) → son inputs numéricos que se escriben a
    //     mano (broker_pnl, other); autosalvar a los 3s interrumpía la escritura
    //     y re-hidrataba el valor a medio tipear. Ingresos se guarda SOLO con
    //     "Guardar Todo". (Sigue en SAVE_HANDLED, así el botón manual lo persiste.)
    const AUTOSAVE_SECTIONS: DataSection[] = ['depositos', 'retiros'];
    if (!AUTOSAVE_SECTIONS.some((s) => dirtySections.has(s))) return;
    if (savingAll) return; // queue up: re-fires when savingAll flips false
    const t = setTimeout(() => {
      // saveAll handles the savingAll lock + error surfacing internally.
      // Fire-and-forget: any error becomes the same toast the manual
      // button produces, so the user sees identical feedback.
      void saveAll();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // saveAll NO va en deps — se recrea en cada render y anularía el debounce;
    // captura `section`/estado por closure. No dependemos de `section`: cambiar
    // de pestaña ya no cancela un guardado pendiente (ese era el bug).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirtySections, savingAll]);

  // ── End auto-save ─────────────────────────────────────────────────────

  // 25-second hard ceiling around each row-level mutation. The DB itself
  // is fast (~6 ms for a single INSERT), but in real-world conditions the
  // total wall-time can stretch when:
  //   · the user is on flaky wifi / mobile data,
  //   · the Supabase JS client transparently retries an auth-refreshed
  //     request (it gives up around ~20s),
  //   · the user has just woken the laptop and the WebSocket is rebuilding.
  // 10 s was too aggressive — it surfaced false-positive timeouts on
  // perfectly healthy writes. 25 s mirrors `SAVE_TIMEOUT_MS` used by the
  // saveAll path; if we hit even that, something is genuinely wrong and
  // we want the user to know rather than spin forever.
  const withRowTimeout = <T,>(p: Promise<T>, label: string, ms = 25_000): Promise<T> =>
    Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${label}: la operación tardó demasiado (>${ms / 1000}s). Reintenta.`)),
          ms,
        ),
      ),
    ]);

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

  // Expense category autocomplete — mirrors the concept pattern above.
  // Categories come from (a) localStorage history and (b) every category ever
  // saved on an expense row for this company.
  const CATEGORY_STORAGE_KEY = 'fd_expense_categories';
  const [categorySuggestions, setCategorySuggestions] = useState<string[]>(() => loadFromStorage(CATEGORY_STORAGE_KEY, [] as string[]));
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const [showEditCategoryDropdown, setShowEditCategoryDropdown] = useState(false);

  useEffect(() => {
    const all = allExpenses.map(e => e.category).filter((c): c is string => !!c && !!c.trim());
    const stored = loadFromStorage<string[]>(CATEGORY_STORAGE_KEY, []);
    const merged = Array.from(new Set([...stored, ...all])).filter(Boolean).sort((a, b) => a.localeCompare(b));
    setCategorySuggestions(merged);
    saveToStorage(CATEGORY_STORAGE_KEY, merged);
  }, [allExpenses]);

  const addCategoryToHistory = (cat: string) => {
    const trimmed = cat.trim();
    if (!trimmed) return;
    setCategorySuggestions(prev => {
      const updated = Array.from(new Set([...prev, trimmed])).sort((a, b) => a.localeCompare(b));
      saveToStorage(CATEGORY_STORAGE_KEY, updated);
      return updated;
    });
  };

  const filteredCategoriesNew = useMemo(() => {
    if (!newExpense.category) return categorySuggestions;
    const q = newExpense.category.toLowerCase();
    return categorySuggestions.filter(c => c.toLowerCase().includes(q));
  }, [newExpense.category, categorySuggestions]);

  const filteredCategoriesEdit = useMemo(() => {
    if (!editExpense.category) return categorySuggestions;
    const q = editExpense.category.toLowerCase();
    return categorySuggestions.filter(c => c.toLowerCase().includes(q));
  }, [editExpense.category, categorySuggestions]);

  const periodLabel = periods.find(p => p.id === selectedPeriod)?.label || '';

  // Feedback via floating bottom-right toasts. Visible regardless of scroll
  // position — replaces the older inline div rendered below the <h1>, which
  // was invisible to users working deep in the Egresos / Liquidez tables.
  const { toast, ToastHost } = useToasts();
  const showSuccess = (msg: string) => toast.success(msg);
  const showError = (msg: string) => toast.error(msg);

  // Back-compat alias so existing call sites keep working. Every remaining
  // usage is a destructive delete — pass `tone: 'danger'` uniformly.
  const askConfirmation = (message: string, onConfirm: () => void) => {
    confirm(message, onConfirm, { tone: 'danger' });
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

  // --- Pagination state (one per table; 25 items per page) ---
  const [expensesPage, setExpensesPage] = useState(0);
  const [liquidityPage, setLiquidityPage] = useState(0);
  const [investmentsPage, setInvestmentsPage] = useState(0);

  // Reset page when the underlying data changes so the user isn't stuck on
  // an empty page after filtering or switching periods.
  useEffect(() => { setExpensesPage(0); }, [selectedPeriod, expenses.length]);
  useEffect(() => { setLiquidityPage(0); }, [liqPeriodFilter, liqDateFrom, liqDateTo, filteredLiquidity.length]);
  useEffect(() => { setInvestmentsPage(0); }, [invPeriodFilter, invDateFrom, invDateTo, filteredInvestments.length]);

  const expensesTotalPages = Math.max(1, Math.ceil(expenses.length / PAGE_SIZE));
  const liquidityTotalPages = Math.max(1, Math.ceil(filteredLiquidity.length / PAGE_SIZE));
  const investmentsTotalPages = Math.max(1, Math.ceil(filteredInvestments.length / PAGE_SIZE));

  // Paged slices — totals/footers still reduce over the FULL data set.
  const pagedExpenses = useMemo(
    () => expenses.slice(expensesPage * PAGE_SIZE, (expensesPage + 1) * PAGE_SIZE),
    [expenses, expensesPage],
  );

  // ── Drag-and-drop reorder for expenses ─────────────────────────────────
  // Sensors: PointerSensor activates after 6px of movement so tiny
  // taps on the handle (e.g. on tablets) don't kidnap the row. Keyboard
  // support is wired for accessibility.
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleExpenseDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      // Indices inside the currently-visible page slice.
      const oldPagedIndex = pagedExpenses.findIndex((e) => e.id === active.id);
      const newPagedIndex = pagedExpenses.findIndex((e) => e.id === over.id);
      if (oldPagedIndex < 0 || newPagedIndex < 0) return;

      // Translate to indices in the full list (rows on other pages stay
      // put). Reordering across pages requires first navigating to that
      // page — intentional: cross-page drag is a footgun.
      const startIdx = expensesPage * PAGE_SIZE;
      const oldIndex = startIdx + oldPagedIndex;
      const newIndex = startIdx + newPagedIndex;

      // Optimistic update — show the new order immediately.
      let reordered: ExpenseRow[] = [];
      setExpenses((prev) => {
        reordered = arrayMove(prev, oldIndex, newIndex);
        return reordered;
      });

      // Persist sort_order — lightweight N-parallel UPDATE, no refresh.
      // Only rows with real UUID ids (already saved in DB) go through;
      // locally-created rows that haven't been saved yet are skipped.
      try {
        const ids = reordered
          .map((e) => e.id)
          .filter((id) => /^[0-9a-f-]{36}$/i.test(id));
        if (ids.length > 0) {
          await updateExpenseOrder(ids);
        }
      } catch (err) {
        console.error('[expenses:reorder] failed to persist order:', err);
        showError(`No se pudo guardar el nuevo orden: ${(err as Error).message}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pagedExpenses, expensesPage],
  );
  const pagedLiquidity = useMemo(
    () => filteredLiquidity.slice(liquidityPage * PAGE_SIZE, (liquidityPage + 1) * PAGE_SIZE),
    [filteredLiquidity, liquidityPage],
  );
  const pagedInvestments = useMemo(
    () => filteredInvestments.slice(investmentsPage * PAGE_SIZE, (investmentsPage + 1) * PAGE_SIZE),
    [filteredInvestments, investmentsPage],
  );

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
    if (savingLiq) return;
    const dep = parseAmount(newLiq.deposit);
    const wth = parseAmount(newLiq.withdrawal);
    (async () => {
      setSavingLiq(true);
      try {
        await withRowTimeout(
          insertLiquidityMovement(company.id, {
            date: newLiq.date,
            user_email: newLiq.user_email || null,
            mt_account: newLiq.mt_account || null,
            deposit: dep,
            withdrawal: wth,
            balance: 0,
          }),
          'Guardar liquidez',
        );
        setNewLiq({ date: '', user_email: '', mt_account: '', deposit: '', withdrawal: '' });
        await withRowTimeout(refreshSections(['liquidez']), 'Recargar datos').catch(() => {
          // Silent refresh failure shouldn't invalidate the successful save.
          console.warn('[liquidez] refresh after add failed');
        });
        setLiquidityRowsRaw([...getLiquidityData()]);
        showSuccess(t('upload.liquidityAdded'));
      } catch (err) {
        showError(`Error: ${(err as Error).message}`);
      } finally {
        setSavingLiq(false);
      }
    })();
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
    if (savingLiq) return;
    const dep = parseAmount(editLiq.deposit);
    const wth = parseAmount(editLiq.withdrawal);
    (async () => {
      setSavingLiq(true);
      try {
        await withRowTimeout(
          updateLiquidityMovement(editingLiqId, {
            date: editLiq.date,
            user_email: editLiq.user_email || null,
            mt_account: editLiq.mt_account || null,
            deposit: dep,
            withdrawal: wth,
            balance: 0,
          }),
          'Actualizar liquidez',
        );
        setEditingLiqId(null);
        await withRowTimeout(refreshSections(['liquidez']), 'Recargar datos').catch(() => {
          console.warn('[liquidez] refresh after edit failed');
        });
        setLiquidityRowsRaw([...getLiquidityData()]);
        showSuccess(t('upload.liquidityUpdated'));
      } catch (err) {
        showError(`Error: ${(err as Error).message}`);
      } finally {
        setSavingLiq(false);
      }
    })();
  };

  const deleteLiqRow = (id: string) => {
    if (!userCanDelete) return;
    if (savingLiq) return;
    askConfirmation('Eliminar este movimiento de liquidez?', async () => {
      setSavingLiq(true);
      try {
        await withRowTimeout(deleteLiqMutation(id), 'Eliminar liquidez');
        await withRowTimeout(refreshSections(['liquidez']), 'Recargar datos').catch(() => {
          console.warn('[liquidez] refresh after delete failed');
        });
        setLiquidityRowsRaw([...getLiquidityData()]);
        showSuccess(t('upload.liquidityDeleted'));
      } catch (err) {
        showError(`Error: ${(err as Error).message}`);
      } finally {
        setSavingLiq(false);
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
    if (savingInv) return;
    const dep = parseAmount(newInv.deposit);
    const wth = parseAmount(newInv.withdrawal);
    const prf = parseAmount(newInv.profit);
    (async () => {
      setSavingInv(true);
      try {
        await withRowTimeout(
          insertInvestment(company.id, {
            date: newInv.date,
            concept: newInv.concept || null,
            responsible: newInv.responsible || null,
            deposit: dep,
            withdrawal: wth,
            profit: prf,
            balance: 0,
          }),
          'Guardar inversión',
        );
        setNewInv({ date: '', concept: '', responsible: '', deposit: '', withdrawal: '', profit: '' });
        await withRowTimeout(refreshSections(['inversiones']), 'Recargar datos').catch(() => {
          console.warn('[inversiones] refresh after add failed');
        });
        setInvestmentRowsRaw([...getInvestmentsData()]);
        showSuccess(t('upload.investmentAdded'));
      } catch (err) {
        showError(`Error: ${(err as Error).message}`);
      } finally {
        setSavingInv(false);
      }
    })();
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
    if (savingInv) return;
    const dep = parseAmount(editInv.deposit);
    const wth = parseAmount(editInv.withdrawal);
    const prf = parseAmount(editInv.profit);
    (async () => {
      setSavingInv(true);
      try {
        await withRowTimeout(
          updateInvestment(editingInvId, {
            date: editInv.date,
            concept: editInv.concept || null,
            responsible: editInv.responsible || null,
            deposit: dep,
            withdrawal: wth,
            profit: prf,
            balance: 0,
          }),
          'Actualizar inversión',
        );
        setEditingInvId(null);
        await withRowTimeout(refreshSections(['inversiones']), 'Recargar datos').catch(() => {
          console.warn('[inversiones] refresh after edit failed');
        });
        setInvestmentRowsRaw([...getInvestmentsData()]);
        showSuccess(t('upload.investmentUpdated'));
      } catch (err) {
        showError(`Error: ${(err as Error).message}`);
      } finally {
        setSavingInv(false);
      }
    })();
  };

  const deleteInvRow = (id: string) => {
    if (!userCanDelete) return;
    if (savingInv) return;
    askConfirmation('Eliminar este movimiento de inversion?', async () => {
      setSavingInv(true);
      try {
        await withRowTimeout(deleteInvMutation(id), 'Eliminar inversión');
        await withRowTimeout(refreshSections(['inversiones']), 'Recargar datos').catch(() => {
          console.warn('[inversiones] refresh after delete failed');
        });
        setInvestmentRowsRaw([...getInvestmentsData()]);
        showSuccess(t('upload.investmentDeleted'));
      } catch (err) {
        showError(`Error: ${(err as Error).message}`);
      } finally {
        setSavingInv(false);
      }
    });
  };

  // Deposit handlers
  //
  // IMPORTANT: `upsertDeposits` is a delete-then-reinsert helper (see
  // `src/lib/supabase/mutations.ts`). If a second list of deposit rows is
  // ever added to this page (e.g. "depósitos adicionales"), the array passed
  // here MUST be the combined list — otherwise the rows not included get
  // wiped on save. Today only fixed channels exist so the array is complete.
  const updateDeposit = (id: string, amount: number) => {
    if (!userCanAdd || !company) return;
    if (savingDepositIds.has(id)) return; // already in flight for this row
    // Skip confirmation modal — the inline input onBlur/save is already a
    // deliberate action. Toast feedback + undo-via-re-edit is faster UX.
    //
    // Optimistic update: apply the change locally immediately, then upsert.
    // On failure, roll back to the pre-edit snapshot AND surface the toast,
    // so the user can see exactly what didn't persist instead of guessing.
    const previousDeposits = deposits;
    const updated = deposits.map(d => d.id === id ? { ...d, amount } : d);
    setDepositsRaw(updated);
    setSavingDepositIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    (async () => {
      Sentry.addBreadcrumb({
        category: 'upload.save',
        message: 'updateDeposit:start',
        data: { id, amount, periodId: selectedPeriodRef.current },
      });
      try {
        await withRowTimeout(
          upsertDeposits(company.id, selectedPeriodRef.current, updated),
          'Guardar depósito',
        );

        if (user) logAction(user.id, user.name, 'update', 'deposits', `Deposito ${CHANNEL_LABELS[deposits.find(d => d.id === id)?.channel || ''] || ''}: $${amount.toLocaleString()}`);
        showSuccess(t('upload.depositRegistered'));

        // Await refresh so callers see fresh data. We do NOT show a
        // toast if refresh returns false: stale generations (a second
        // save firing while this one is still refreshing) are common
        // and benign — the local optimistic update already shows the
        // correct value, and the latest refresh will settle the
        // DataProvider. Only a true network failure / timeout matters,
        // and that surfaces through the regular catch below.
        await refreshSections(['depositos']);
      } catch (err) {
        // Rollback the optimistic update so the cell reverts to what
        // was actually in DB before we touched it.
        setDepositsRaw(previousDeposits);
        Sentry.captureException(err, {
          tags: { area: 'upload.updateDeposit' },
          extra: { id, amount, periodId: selectedPeriodRef.current },
        });
        showError(`Error al guardar depósito: ${(err as Error).message}`);
      } finally {
        setSavingDepositIds(prev => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    })();
  };

  // Withdrawal handlers
  const updateWithdrawal = (id: string, amount: number) => {
    if (!userCanAdd || !company) return;
    if (savingWithdrawalIds.has(id)) return;
    // Skip confirmation modal — the inline input commit (blur / enter) is
    // the deliberate action. Toast feedback gives the user a fast signal
    // without the extra click. Optimistic + rollback mirrors updateDeposit.
    const previousWithdrawals = withdrawals;
    const updated = withdrawals.map(w => w.id === id ? { ...w, amount } : w);
    setWithdrawalsRaw(updated);
    setSavingWithdrawalIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    (async () => {
      Sentry.addBreadcrumb({
        category: 'upload.save',
        message: 'updateWithdrawal:start',
        data: { id, amount, periodId: selectedPeriodRef.current },
      });
      try {
        // Combine fixed withdrawals with extras so upsert (delete+reinsert) doesn't wipe extras
        const combined = [
          ...updated.map(w => ({ category: w.category, amount: w.amount, description: null as string | null })),
          ...withdrawalExtras.map(w => ({ category: w.category, amount: w.amount, description: w.description || null })),
        ];
        await withRowTimeout(
          upsertWithdrawals(company.id, selectedPeriodRef.current, combined),
          'Guardar retiro',
        );

        if (user) logAction(user.id, user.name, 'update', 'withdrawals', `Retiro ${WITHDRAWAL_LABELS[withdrawals.find(w => w.id === id)?.category || ''] || ''}: $${amount.toLocaleString()}`);
        showSuccess(t('upload.withdrawalRegistered'));

        // Same rationale as updateDeposit: skip false-positive toast on
        // stale refresh (common when user clicks Save on a second row
        // before the first refresh resolves). Real failures still
        // surface via catch.
        await refreshSections(['retiros']);
      } catch (err) {
        setWithdrawalsRaw(previousWithdrawals);
        Sentry.captureException(err, {
          tags: { area: 'upload.updateWithdrawal' },
          extra: { id, amount, periodId: selectedPeriodRef.current },
        });
        showError(`Error al guardar retiro: ${(err as Error).message}`);
      } finally {
        setSavingWithdrawalIds(prev => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    })();
  };

  // Expense handlers — persistencia POR ACCIÓN (2026-07-12).
  //
  // Antes los egresos se acumulaban en estado local y dependían de "Guardar
  // Todo" (un batch grande que, si el request de red se estancaba, colgaba
  // 25s y fallaba entero — el bug que Kevin reportó repetidamente). Ahora
  // cada agregar/editar/borrar/fijar persiste al instante, igual que
  // depósitos y retiros: optimista en pantalla + upsert atómico resiliente
  // (timeout 12s + reintento en la capa de mutación) + rollback si falla. No
  // se pierde nada aunque el usuario cierre la pestaña.
  //
  // Se marca 'egresos' dirty MIENTRAS guarda para que el sync-effect no
  // rehidrate la tabla desde una lectura a medio-camino; al terminar se
  // limpia el dirty, disparando un re-sync limpio desde la DB (con ids
  // reales, reemplazando el id temporal optimista).
  const [savingExpenses, setSavingExpenses] = useState(false);

  const persistExpenses = async (
    nextList: ExpenseRow[],
    previousList: ExpenseRow[],
    opts: { toast: string; audit?: { action: 'create' | 'update' | 'delete'; details: string } },
  ) => {
    if (!company) return;
    markDirty('egresos');
    setSavingExpenses(true);
    try {
      await withRowTimeout(
        upsertExpenses(company.id, selectedPeriodRef.current, nextList),
        'Guardar egreso',
      );
      if (user && opts.audit) {
        logAction(user.id, user.name, opts.audit.action, 'expenses', opts.audit.details);
      }
      showSuccess(opts.toast);
      await refreshSections(['egresos']);
    } catch (err) {
      setExpensesRaw(previousList); // rollback al estado previo (= lo que hay en DB)
      Sentry.captureException(err, {
        tags: { area: 'upload.persistExpenses' },
        extra: { periodId: selectedPeriodRef.current },
      });
      showError(`Error al guardar egreso: ${(err as Error).message}`);
    } finally {
      setSavingExpenses(false);
      clearDirty('egresos'); // re-sync desde DB (ids reales) o limpia tras rollback
    }
  };

  const addExpense = () => {
    if (!userCanAdd || !company || !newExpense.concept || !newExpense.amount) return;
    const amt = parseAmount(newExpense.amount);
    const pd = parseAmount(newExpense.paid);
    const pn = computeExpensePending(newExpense.amount, newExpense.paid, newExpense.pending);
    const cat = newExpense.category.trim() || null;
    const previous = expenses;
    const next: ExpenseRow[] = [...expenses, {
      id: `exp-${Date.now()}`,
      concept: newExpense.concept,
      amount: amt,
      paid: pd,
      pending: pn,
      is_fixed: newExpense.is_fixed,
      category: cat,
    }];
    setExpensesRaw(next); // optimista
    setNewExpense({ concept: '', amount: '', paid: '', pending: '', is_fixed: false, category: '' });
    addConceptToHistory(newExpense.concept);
    if (cat) addCategoryToHistory(cat);
    void persistExpenses(next, previous, {
      toast: t('upload.expenseAdded'),
      audit: { action: 'create', details: `Egreso creado: ${newExpense.concept}, monto: $${amt.toLocaleString()}` },
    });
  };

  const startEditExpense = (exp: ExpenseRow) => {
    if (!userCanEdit) return;
    setEditingExpenseId(exp.id);
    setEditExpense({ concept: exp.concept, amount: String(exp.amount), paid: String(exp.paid), pending: String(exp.pending), is_fixed: !!exp.is_fixed, category: exp.category ?? '' });
  };

  const saveEditExpense = () => {
    if (!editingExpenseId) return;
    const amt = parseAmount(editExpense.amount);
    const pd = parseAmount(editExpense.paid);
    const pn = computeExpensePending(editExpense.amount, editExpense.paid, editExpense.pending);
    const cat = editExpense.category.trim() || null;
    const previous = expenses;
    const concept = editExpense.concept;
    const next = expenses.map(e => e.id === editingExpenseId ? { ...e, concept, amount: amt, paid: pd, pending: pn, is_fixed: editExpense.is_fixed, category: cat } : e);
    setExpensesRaw(next); // optimista
    if (cat) addCategoryToHistory(cat);
    setEditingExpenseId(null);
    void persistExpenses(next, previous, {
      toast: t('upload.expenseUpdated'),
      audit: { action: 'update', details: `Egreso ${concept}: $${amt.toLocaleString()}` },
    });
  };

  const toggleExpenseFixed = (id: string) => {
    if (!userCanEdit) return;
    const previous = expenses;
    const target = expenses.find(e => e.id === id);
    const next = expenses.map(e => e.id === id ? { ...e, is_fixed: !e.is_fixed } : e);
    setExpensesRaw(next); // optimista
    void persistExpenses(next, previous, {
      toast: 'Egreso actualizado',
      audit: { action: 'update', details: `Egreso ${target?.concept ?? ''} marcado ${target?.is_fixed ? 'no fijo' : 'fijo'}` },
    });
  };

  // Marcar un egreso como pagado en un click: paid = amount, pending = 0.
  // Pedido de Kevin (2026-07-13) — sobre todo para los egresos fijos, sin
  // tener que abrir la edición. Persiste por-acción (ahora server-side, rápido).
  const markExpensePaid = (id: string) => {
    if (!userCanEdit) return;
    const target = expenses.find(e => e.id === id);
    if (!target || target.pending <= 0) return; // ya está pagado
    const previous = expenses;
    const next = expenses.map(e => e.id === id ? { ...e, paid: e.amount, pending: 0 } : e);
    setExpensesRaw(next); // optimista
    void persistExpenses(next, previous, {
      toast: `"${target.concept}" marcado como pagado`,
      audit: { action: 'update', details: `Egreso marcado como pagado: ${target.concept} ($${target.amount.toLocaleString()})` },
    });
  };

  const deleteExpense = (id: string) => {
    if (!userCanDelete) return;
    const exp = expenses.find(e => e.id === id);
    askConfirmation(`Eliminar egreso "${exp?.concept}"?`, () => {
      const previous = expenses;
      const next = expenses.filter(e => e.id !== id);
      setExpensesRaw(next); // optimista
      void persistExpenses(next, previous, {
        toast: t('upload.expenseDeleted'),
        audit: { action: 'delete', details: `Egreso eliminado: ${exp?.concept ?? ''}` },
      });
    });
  };

  // Income handler
  //
  // Saves three things in one click — they share a tab in the UI so users
  // expect "Guardar Ingresos" to persist everything visible:
  //   1. operating_income (broker_pnl, other) — the historical pair.
  //   2. prop_firm_sales — single roll-up amount per period; the Prop Firm
  //      "ventas" input was added 2026-05-01 so the net (sales − retiros)
  //      can flow into Total Ingresos without leaving the page.
  //   3. withdrawals — the Prop Firm "retiros" share state with the
  //      Retiros tab. We persist the FULL withdrawals payload (4 aggregates
  //      + extras) the same way `saveAll('retiros')` does so editing the
  //      prop_firm row from Ingresos doesn't wipe other categories or any
  //      manual extras the user already added.
  const saveIncome = () => {
    if (!userCanAdd || !company) return;
    (async () => {
      Sentry.addBreadcrumb({
        category: 'upload.save',
        message: 'saveIncome:start',
        data: { periodId: selectedPeriodRef.current },
      });
      try {
        const periodId = selectedPeriodRef.current;
        const combinedWithdrawals = [
          ...withdrawals.map(w => ({ category: w.category, amount: w.amount, description: null as string | null })),
          ...withdrawalExtras.map(w => ({ category: w.category, amount: w.amount, description: w.description || null })),
        ];
        await upsertOperatingIncome(company.id, periodId, income);
        await upsertPropFirmSales(company.id, periodId, propFirmAmount);
        await upsertWithdrawals(company.id, periodId, combinedWithdrawals);

        if (user) {
          const propFirmWdr = withdrawals.find(w => w.category === 'prop_firm')?.amount || 0;
          const propFirmNet = propFirmAmount - propFirmWdr;
          logAction(
            user.id,
            user.name,
            'update',
            'income',
            `Ingresos operativos: Broker $${income.broker_pnl.toLocaleString()}, Otros $${income.other.toLocaleString()}, Prop Firm net $${propFirmNet.toLocaleString()}`,
          );
        }
        showSuccess(t('upload.incomeSaved'));
        Sentry.addBreadcrumb({
          category: 'upload.save',
          message: 'saveIncome:success',
          data: { periodId },
        });
        // Refresh + THEN clear dirty for the saved sections only.
        // saveIncome persists `operating_income` + `prop_firm_sales` (own
        // dirty bucket: 'ingresos') AND `withdrawals` (which lives in
        // 'retiros'). Clear both so the sync effect can re-hydrate from
        // the fresh DataProvider state without stomping on any other
        // section the user may still be editing.
        //
        // Critical (Kevin 2026-06-06): only clear dirty when refresh
        // REALLY succeeded. If refresh returned false because of a true
        // failure (timeout, RLS, network), the DataProvider still holds
        // stale rows. Clearing dirty would let the sync effect
        // overwrite the user's just-saved local edit with the stale
        // DB read. Now stale-races return `true` from refresh (handled
        // in data-context.tsx), so `false` is reserved for real
        // failures — and in those we keep dirty marked so the next
        // save attempt re-pushes the data once the network recovers.
        const ok = await refreshSections(['ingresos']);
        if (ok) {
          clearDirty('ingresos');
          clearDirty('retiros');
        } else {
          showError('Los ingresos se guardaron pero no se pudieron recargar. Puedes seguir editando, el indicador "cambios sin guardar" se limpiará en la próxima recarga.');
        }
      } catch (err) {
        const message = (err as Error).message;
        Sentry.captureException(err, {
          tags: { area: 'upload.saveIncome' },
          extra: { periodId: selectedPeriodRef.current, companyId: company.id },
        });
        showError(`Error: ${message}`);
        // dirty is intentionally NOT cleared on error — the user's
        // unsaved edits stay protected from the sync effect overwriting
        // them, so they can fix the network / validation issue and retry
        // without re-entering everything.
      }
    })();
  };

  // Save All handler — saves all fields in the current section to Supabase.
  // Liquidez and Inversiones persist per-row so they're not in here (they
  // have Add/Edit/Save buttons right on each row).
  //
  // Bug fixed 2026-04-22: the previous version awaited `refresh()` BEFORE
  // flipping `savingAll` back to false. Since refresh() reloads the entire
  // data-context (periods + deposits + withdrawals + expenses + 14 more
  // tables with retries up to 60s), a slow refresh left the "Guardar todo"
  // button stuck in "Guardando..." state even though the real DB write had
  // already succeeded. Users assumed the save failed and retried, stacking
  // duplicate writes.
  //
  // New flow:
  //   1. Run the main save (upsertX) — this is the only thing we await.
  //   2. Show success + flip button state IMMEDIATELY.
  //   3. Kick off refresh() in the background — the UI can afford to show
  //      slightly stale numbers for a second while the context reloads.
  //   4. Hard 25s safety timeout around the main save so network death
  //      doesn't lock the button forever.
  // Candado re-entrante (fix 2026-06-20): el gate `if (savingAll)` del
  // autosave lee el STATE de React, que se actualiza async — si el timer del
  // autosave y el click en "Guardar Todo" caen en la misma ventana de render,
  // ambos veían savingAll=false y corrían DOS saveAll en paralelo (dos
  // reemplazos del período compitiendo). El ref es síncrono: el segundo
  // entrante sale inmediatamente.
  const saveAllInFlightRef = useRef(false);
  const saveAll = async () => {
    if (!userCanAdd || !company) return;
    if (saveAllInFlightRef.current) return;
    saveAllInFlightRef.current = true;
    setSavingAll(true);
    const companyId = company.id;
    const periodId = selectedPeriodRef.current;

    const SAVE_TIMEOUT_MS = 25_000;
    const timedSave = async (work: () => Promise<void>, label: string) => {
      await Promise.race([
        work(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${label} tardó demasiado (>25s). Reintenta.`)),
            SAVE_TIMEOUT_MS,
          ),
        ),
      ]);
    };

    // BUG-03: persistir TODAS las secciones con cambios sin guardar, no solo
    // la visible. Antes saveAll solo guardaba `section`, así que editar
    // Depósitos, cambiar a Egresos y dejar correr el autosave dejaba Depósitos
    // sin persistir hasta volver a esa pestaña — se perdía al recargar. Ahora
    // guarda la unión de las secciones dirty + la visible.
    // Egresos NO entra: persiste por-acción (persistExpenses) y usa 'egresos'
    // dirty como mutex del sync-effect — batchearlo acá crearía una carrera.
    const SAVE_HANDLED: DataSection[] = ['depositos', 'retiros', 'ingresos'];
    const targets = SAVE_HANDLED.filter((s) => dirtySections.has(s) || s === section);

    // Guarda UNA sección y devuelve su mensaje de éxito. Las mutaciones son
    // atómicas/idempotentes, así que el solapamiento entre secciones (p.ej.
    // 'ingresos' y 'retiros' ambas escriben withdrawals desde el mismo estado)
    // es inofensivo.
    const saveSectionWork = async (sec: DataSection): Promise<string> => {
      if (sec === 'depositos') {
        await upsertDeposits(companyId, periodId, deposits);
        await upsertPropFirmSales(companyId, periodId, propFirmAmount);
        if (user) logAction(user.id, user.name, 'update', 'deposits', `Todos los depositos guardados para ${periodLabel}`);
        const nonZero = deposits.filter(d => d.amount !== 0).length;
        return `${nonZero} depósito${nonZero === 1 ? '' : 's'} guardado${nonZero === 1 ? '' : 's'} correctamente`;
      } else if (sec === 'retiros') {
        const combined = [
          ...withdrawals.map(w => ({ category: w.category, amount: w.amount, description: null as string | null })),
          ...withdrawalExtras.map(w => ({ category: w.category, amount: w.amount, description: w.description || null })),
        ];
        await upsertWithdrawals(companyId, periodId, combined);
        await upsertP2PTransfers(companyId, periodId, p2pAmount);
        if (user) logAction(user.id, user.name, 'update', 'withdrawals', `Todos los retiros guardados para ${periodLabel}`);
        const nonZero = withdrawals.filter(w => w.amount !== 0).length + withdrawalExtras.length;
        return `${nonZero} retiro${nonZero === 1 ? '' : 's'} guardado${nonZero === 1 ? '' : 's'} correctamente`;
      } else {
        // ingresos — mismo payload que saveIncome: income + prop firm ventas
        // + withdrawals (la pestaña Ingresos también posee esos campos).
        const combinedWithdrawals = [
          ...withdrawals.map(w => ({ category: w.category, amount: w.amount, description: null as string | null })),
          ...withdrawalExtras.map(w => ({ category: w.category, amount: w.amount, description: w.description || null })),
        ];
        await upsertOperatingIncome(companyId, periodId, income);
        await upsertPropFirmSales(companyId, periodId, propFirmAmount);
        await upsertWithdrawals(companyId, periodId, combinedWithdrawals);
        if (user) logAction(user.id, user.name, 'update', 'income', `Ingresos operativos guardados para ${periodLabel}`);
        return 'Ingresos operativos guardados correctamente';
      }
    };

    const saved: DataSection[] = [];
    const messages: string[] = [];
    let successMsg = 'Datos guardados correctamente';
    try {
      await timedSave(async () => {
        for (const sec of targets) {
          messages.push(await saveSectionWork(sec));
          saved.push(sec);
        }
      }, 'Guardar todo');
      successMsg = messages.length <= 1
        ? (messages[0] ?? successMsg)
        : `${saved.length} secciones guardadas correctamente`;

      // Main save succeeded. Show success + unlock the button NOW.
      showSuccess(successMsg);
      saveAllInFlightRef.current = false;
      setSavingAll(false);
      setLastSavedAt(new Date());
      Sentry.addBreadcrumb({
        category: 'upload.save',
        message: 'saveAll:success',
        data: { sections: saved, periodId },
      });

      // Refresh + THEN clear the dirty flag for the saved section.
      //
      // Bug fixed 2026-05-02: clearing dirty BEFORE refresh completed
      // raced with the sync effect. When dirty flipped to null, the
      // effect ran `setExpensesRaw(loadExpensesForPeriod(...))` which
      // read `allExpenses` from the DataProvider — still pre-save
      // because refresh is async and hadn't propagated yet. Local state
      // was overwritten with stale DB rows, dropping the just-saved
      // additions. The user saw "no quedaron guardados" even though the
      // upsert succeeded.
      //
      // Updated 2026-05-13: clearDirty is now scoped to the section
      // we just saved, so editing in a DIFFERENT section concurrently
      // is no longer wiped on refresh. Ingresos also clears 'retiros'
      // because that's what its payload upserts.
      //
      // Updated 2026-06-06 (regression fix): only clearDirty when the
      // refresh REALLY succeeded. Previously, on refresh failure we
      // still cleared dirty + showed a toast — but the sync effect
      // would then re-hydrate local state from the stale DataProvider,
      // wiping the user's just-saved row from view. The user's next
      // edit + save would then re-upsert with the (now-overwritten)
      // stale array and erase what was originally persisted. With this
      // guard, on a real refresh failure the dirty stays marked, the
      // banner stays up, and the next save attempt re-pushes the
      // current local view (which is correct).
      // B1: refresh selectivo — solo las tablas de las secciones guardadas
      // (2-3 queries c/u) en vez de recargar toda la empresa (~19 queries).
      const ok = await refreshSections(
        saved as Array<'depositos' | 'retiros' | 'egresos' | 'ingresos' | 'liquidez' | 'inversiones'>,
      );
      if (ok) {
        for (const sec of saved) {
          clearDirty(sec);
          if (sec === 'ingresos') clearDirty('retiros');
        }
      } else {
        showError('Datos guardados pero no se pudo recargar. Puedes seguir editando — el indicador "cambios sin guardar" se limpiará al próximo save exitoso.');
      }
    } catch (err) {
      const message = (err as Error).message;
      Sentry.captureException(err, {
        tags: { area: 'upload.saveAll', section },
        extra: { periodId, companyId, periodLabel },
      });
      showError(`Error al guardar: ${message}`);
      saveAllInFlightRef.current = false;
      setSavingAll(false);
      // dirty is intentionally NOT cleared on error — the user's
      // in-progress edits stay protected so they can retry without
      // re-entering everything. The granular dirty Set means this no
      // longer blocks other sections from re-syncing.
    }
  };

  // Doc handler
  const handleDocUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setDocs(prev => [{ id: `doc-${Date.now()}`, filename: f.name, date: new Date().toISOString().split('T')[0], description: '', uploaded_by: user?.name || '' }, ...prev]);
    showSuccess(t('upload.documentUploaded'));
    e.target.value = '';
  };

  // Liquidity totals
  const liqTotalDeposits = filteredLiquidity.reduce((s, r) => s + r.deposit, 0);
  const liqTotalWithdrawals = filteredLiquidity.reduce((s, r) => s + r.withdrawal, 0);

  // Investment totals
  const invTotalDeposits = filteredInvestments.reduce((s, r) => s + r.deposit, 0);
  const invTotalWithdrawals = filteredInvestments.reduce((s, r) => s + r.withdrawal, 0);
  const invTotalProfit = filteredInvestments.reduce((s, r) => s + r.profit, 0);

  // Balance maps — computed on-the-fly. The stored `balance` column is
  // unreliable (insert passes 0; recalc* never runs). Use these everywhere
  // we need a per-row or cumulative balance.
  const liqBalanceMap = useMemo(() => {
    const map = new Map<string, number>();
    const sorted = [...liquidityRows].sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    for (const r of sorted) {
      running += r.deposit - r.withdrawal;
      map.set(r.id, running);
    }
    return map;
  }, [liquidityRows]);
  const invBalanceMap = useMemo(() => {
    const map = new Map<string, number>();
    const sorted = [...investmentRows].sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    for (const r of sorted) {
      running += r.deposit - r.withdrawal + r.profit;
      map.set(r.id, running);
    }
    return map;
  }, [investmentRows]);

  const liqCurrentBalance = useMemo(() => {
    if (filteredLiquidity.length === 0) return 0;
    const sortedFiltered = [...filteredLiquidity].sort((a, b) => a.date.localeCompare(b.date));
    return liqBalanceMap.get(sortedFiltered.at(-1)!.id) ?? 0;
  }, [filteredLiquidity, liqBalanceMap]);
  const invCurrentBalance = useMemo(() => {
    if (filteredInvestments.length === 0) return 0;
    const sortedFiltered = [...filteredInvestments].sort((a, b) => a.date.localeCompare(b.date));
    return invBalanceMap.get(sortedFiltered.at(-1)!.id) ?? 0;
  }, [filteredInvestments, invBalanceMap]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{t('upload.title')}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t('upload.subtitle')}</p>
      </div>

      {/* Feedback lives in the floating ToastHost at bottom-right. Rendered
          at the end of this component so it sits above everything else. */}

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
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[480px]">
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
                        disabled={savingDepositIds.has(d.id)}
                        onChange={(e) => setDeposits(prev => prev.map(dd => dd.id === d.id ? { ...dd, amount: parseFloat(e.target.value) || 0 } : dd))}
                        className="w-full text-right px-3 py-1.5 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 disabled:cursor-progress"
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
                        disabled={savingDepositIds.has(d.id)}
                        className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 transition-colors disabled:opacity-50 disabled:cursor-progress"
                        title={savingDepositIds.has(d.id) ? 'Guardando...' : t('common.save')}
                        aria-busy={savingDepositIds.has(d.id)}
                      >
                        <Save className={`w-4 h-4 ${savingDepositIds.has(d.id) ? 'animate-pulse' : ''}`} />
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
          </div>

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
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[480px]">
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
                      {userCanAdd ? (
                        <div className="flex flex-col items-end gap-1">
                          <input
                            type="number"
                            step="0.01"
                            value={w.amount || ''}
                            disabled={savingWithdrawalIds.has(w.id)}
                            onChange={(e) => setWithdrawals(prev => prev.map(ww => ww.id === w.id ? { ...ww, amount: parseFloat(e.target.value) || 0 } : ww))}
                            className="w-full text-right px-3 py-1.5 rounded border border-border bg-background focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50 disabled:cursor-progress"
                            placeholder="0.00"
                          />
                          {/* When broker row is in derived-logic period, show
                              the API-derived amount as info BESIDE the manual
                              input. Both coexist: the final broker total in
                              /movimientos = derived + this manual input. */}
                          {isBrokerAutoRow && (
                            <span className="text-[10px] text-muted-foreground">
                              + API {formatCurrency(derivedBrokerAmount)} (auto)
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="font-medium">{formatCurrency(w.amount)}</span>
                      )}
                    </td>
                    {userCanAdd && (
                      <td className="py-3 px-3 text-center">
                        <button
                          onClick={() => updateWithdrawal(w.id, w.amount)}
                          disabled={savingWithdrawalIds.has(w.id)}
                          className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 transition-colors disabled:opacity-50 disabled:cursor-progress"
                          title={savingWithdrawalIds.has(w.id) ? 'Guardando...' : t('common.save')}
                          aria-busy={savingWithdrawalIds.has(w.id)}
                        >
                          <Save className={`w-4 h-4 ${savingWithdrawalIds.has(w.id) ? 'animate-pulse' : ''}`} />
                        </button>
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
                    // Total includes the manual amount entered in THIS form
                    // for every row. The API-derived broker amount is NOT
                    // added here because it's an auto-calculation shown for
                    // reference — the Movimientos page adds it at render
                    // time so both sources remain visible separately.
                    withdrawals.reduce((s, w) => s + w.amount, 0) +
                    (brokerIsDerived ? derivedBrokerAmount : 0)
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
                    Broker: el campo manual de arriba convive con el monto
                    auto-derivado de Coinsbuy. En Movimientos se muestran
                    ambos por separado y se suman al total.
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
          </div>

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

          {/* ─── Retiros adicionales manuales ─────────────────────────── */}
          {/* Free-form entries that coexist with what the APIs report.
              Stored with a non-null `description` in the withdrawals table
              so they can be listed separately from the 4 fixed aggregates. */}
          <div className="mt-6 pt-5 border-t border-border">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-sm font-semibold">Retiros manuales adicionales</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Se guardan en la BD junto con los 4 agregados arriba y conviven con los datos de las APIs.
                </p>
              </div>
            </div>

            {/* Add form */}
            {userCanAdd && (
              <div className="grid grid-cols-1 md:grid-cols-5 gap-2 mb-3">
                <select
                  value={newExtraWithdrawal.category}
                  onChange={(e) => setNewExtraWithdrawal(p => ({ ...p, category: e.target.value as typeof p.category }))}
                  className="px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                >
                  <option value="ib_commissions">{WITHDRAWAL_LABELS['ib_commissions']}</option>
                  <option value="broker">{WITHDRAWAL_LABELS['broker']}</option>
                  <option value="prop_firm">{WITHDRAWAL_LABELS['prop_firm']}</option>
                  <option value="other">{WITHDRAWAL_LABELS['other']}</option>
                </select>
                <input
                  type="text"
                  value={newExtraWithdrawal.description}
                  onChange={(e) => setNewExtraWithdrawal(p => ({ ...p, description: e.target.value }))}
                  placeholder="Descripción (ej: retiro manual, ajuste)"
                  className="md:col-span-2 px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <input
                  type="number"
                  step="0.01"
                  value={newExtraWithdrawal.amount}
                  onChange={(e) => setNewExtraWithdrawal(p => ({ ...p, amount: e.target.value }))}
                  placeholder="Monto"
                  className="text-right px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                />
                <button
                  type="button"
                  onClick={() => {
                    const amt = parseFloat(newExtraWithdrawal.amount) || 0;
                    if (!newExtraWithdrawal.description.trim() || amt <= 0) return;
                    setWithdrawalExtras(prev => [...prev, {
                      id: `extra-${Date.now()}`,
                      category: newExtraWithdrawal.category,
                      amount: amt,
                      description: newExtraWithdrawal.description.trim(),
                    }]);
                    setNewExtraWithdrawal({ category: 'broker', amount: '', description: '' });
                  }}
                  disabled={!newExtraWithdrawal.description.trim() || !(parseFloat(newExtraWithdrawal.amount) > 0)}
                  className="px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-4 h-4" /> Agregar
                </button>
              </div>
            )}

            {/* List of extras */}
            {withdrawalExtras.length === 0 ? (
              <p className="text-center text-xs text-muted-foreground py-4">
                {userCanAdd ? 'Agrega entradas libres cuando necesites registrar un retiro fuera de los 4 agregados.' : 'Sin retiros manuales adicionales.'}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 px-3 text-muted-foreground font-medium">Categoría</th>
                      <th className="text-left py-2 px-3 text-muted-foreground font-medium">Descripción</th>
                      <th className="text-right py-2 px-3 text-muted-foreground font-medium">Monto</th>
                      {userCanAdd && <th className="w-16 text-center py-2 px-3 text-muted-foreground font-medium">Acción</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {withdrawalExtras.map((w) => (
                      <tr key={w.id} className="border-b border-border/50 hover:bg-muted/50">
                        <td className="py-2.5 px-3">
                          <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                            {WITHDRAWAL_LABELS[w.category]}
                          </span>
                        </td>
                        <td className="py-2.5 px-3">{w.description}</td>
                        <td className="py-2.5 px-3 text-right font-medium text-red-600">{formatCurrency(w.amount)}</td>
                        {userCanAdd && (
                          <td className="py-2.5 px-3 text-center">
                            <button
                              onClick={() => setWithdrawalExtras(prev => prev.filter(x => x.id !== w.id))}
                              className="p-1 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded"
                              title="Eliminar"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-bold bg-muted/50">
                      <td colSpan={2} className="py-3 px-3">Total extras</td>
                      <td className="py-3 px-3 text-right text-red-600">
                        {formatCurrency(withdrawalExtras.reduce((s, w) => s + w.amount, 0))}
                      </td>
                      {userCanAdd && <td></td>}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* EGRESOS */}
      {section === 'egresos' && (
        <Card>
          <h2 className="text-base sm:text-lg font-semibold mb-4">Egresos Operativos — {periodLabel}</h2>
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleExpenseDragEnd}
          >
          <table className="w-full text-sm min-w-[500px]">
            <thead>
              <tr className="border-b border-border">
                <th className="w-8 py-2 px-2" aria-label="Reordenar"></th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">#</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Concepto</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Categoría</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Monto</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Pagado</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Pendiente</th>
                <th className="text-center py-2 px-3 text-muted-foreground font-medium">Estado</th>
                {(userCanEdit || userCanDelete) && <th className="w-24 text-center py-2 px-3 text-muted-foreground font-medium">Acciones</th>}
              </tr>
            </thead>
            <SortableContext
              items={pagedExpenses.map((e) => e.id)}
              strategy={verticalListSortingStrategy}
            >
            <tbody>
              {expenses.length === 0 && (
                <tr><td colSpan={9} className="py-8 text-center text-muted-foreground">No hay egresos registrados. {userCanAdd && 'Agrega uno abajo.'}</td></tr>
              )}
              {pagedExpenses.map((exp, i) => (
                <SortableExpenseRow
                  key={exp.id}
                  id={exp.id}
                  disabled={!userCanEdit || editingExpenseId === exp.id}
                >
                  {editingExpenseId === exp.id ? (
                    <>
                      <td className="py-2 px-3 text-muted-foreground">{expensesPage * PAGE_SIZE + i + 1}</td>
                      <td className="py-2 px-3">
                        <input aria-label="Concepto del gasto" value={editExpense.concept} onChange={e => setEditExpense(p => ({ ...p, concept: e.target.value }))} className="w-full px-2 py-1 rounded border border-border text-sm" />
                        <label className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground cursor-pointer">
                          <input type="checkbox" aria-label="Gasto fijo" checked={editExpense.is_fixed} onChange={e => setEditExpense(p => ({ ...p, is_fixed: e.target.checked }))} className="w-3 h-3" />
                          {t('expenses.fixed')} ({t('expenses.fixedHint')})
                        </label>
                      </td>
                      <td className="py-2 px-3">
                        <div className="relative">
                          <input
                            value={editExpense.category}
                            onChange={e => { setEditExpense(p => ({ ...p, category: e.target.value })); setShowEditCategoryDropdown(true); }}
                            onFocus={() => setShowEditCategoryDropdown(true)}
                            onBlur={() => setTimeout(() => setShowEditCategoryDropdown(false), 200)}
                            placeholder="Categoría"
                            className="w-full px-2 py-1 rounded border border-border text-sm"
                            autoComplete="off"
                          />
                          {showEditCategoryDropdown && filteredCategoriesEdit.length > 0 && (
                            <div className="absolute z-30 top-full left-0 right-0 mt-1 max-h-40 overflow-auto bg-card border border-border rounded-lg shadow-lg">
                              {filteredCategoriesEdit.map(c => (
                                <button
                                  key={c}
                                  type="button"
                                  onMouseDown={(e) => { e.preventDefault(); setEditExpense(p => ({ ...p, category: c })); setShowEditCategoryDropdown(false); }}
                                  className="w-full text-left px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                                >
                                  {c}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="py-2 px-3"><input type="number" step="0.01" aria-label="Monto del gasto" value={editExpense.amount} onChange={e => setEditExpense(p => ({ ...p, amount: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                      <td className="py-2 px-3"><input type="number" step="0.01" aria-label="Pagado" value={editExpense.paid} onChange={e => setEditExpense(p => ({ ...p, paid: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                      <td className="py-2 px-3"><input type="number" step="0.01" aria-label="Pendiente" value={editExpense.pending} onChange={e => setEditExpense(p => ({ ...p, pending: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
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
                      <td className="py-2.5 px-3 text-muted-foreground">{expensesPage * PAGE_SIZE + i + 1}</td>
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
                      <td className="py-2.5 px-3">
                        {exp.category ? (
                          <span className="inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700">
                            {exp.category}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
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
                            {userCanEdit && exp.pending > 0 && (
                              <button onClick={() => markExpensePaid(exp.id)} className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 rounded" title="Marcar como pagado" aria-label={`Marcar ${exp.concept} como pagado`}><Check className="w-3.5 h-3.5" /></button>
                            )}
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
                </SortableExpenseRow>
              ))}
            </tbody>
            </SortableContext>
            {expenses.length > 0 && (
              <tfoot>
                <tr className="font-bold bg-muted/50">
                  <td className="py-3 px-3" colSpan={4}>Total</td>
                  <td className="py-3 px-3 text-right">{formatCurrency(expenses.reduce((s, e) => s + e.amount, 0))}</td>
                  <td className="py-3 px-3 text-right">{formatCurrency(expenses.reduce((s, e) => s + e.paid, 0))}</td>
                  <td className="py-3 px-3 text-right">{formatCurrency(expenses.reduce((s, e) => s + e.pending, 0))}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            )}
          </table>
          </DndContext>
          </div>

          <PaginationControls
            page={expensesPage}
            totalPages={expensesTotalPages}
            totalItems={expenses.length}
            onChange={setExpensesPage}
          />

          {/* Add expense form */}
          {userCanAdd && (
            <div className="mt-4 pt-4 border-t border-border">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Plus className="w-4 h-4" /> {t('upload.addExpense')}</h3>
              <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
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
                <div className="relative">
                  <input
                    value={newExpense.category}
                    onChange={e => { setNewExpense(p => ({ ...p, category: e.target.value })); setShowCategoryDropdown(true); }}
                    onFocus={() => setShowCategoryDropdown(true)}
                    onBlur={() => setTimeout(() => setShowCategoryDropdown(false), 200)}
                    placeholder="Categoría"
                    className="w-full px-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
                    autoComplete="off"
                  />
                  {showCategoryDropdown && filteredCategoriesNew.length > 0 && (
                    <div className="absolute z-20 top-full left-0 right-0 mt-1 max-h-48 overflow-auto bg-card border border-border rounded-lg shadow-lg">
                      {filteredCategoriesNew.map(c => (
                        <button
                          key={c}
                          type="button"
                          onMouseDown={(e) => { e.preventDefault(); setNewExpense(p => ({ ...p, category: c })); setShowCategoryDropdown(false); }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                  {newExpense.category && !filteredCategoriesNew.some(c => c.toLowerCase() === newExpense.category.toLowerCase()) && (
                    <p className="text-[11px] text-muted-foreground mt-1 px-1">Nueva categoría · se guardará al agregar</p>
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
                  disabled={!newExpense.concept || !newExpense.amount || savingExpenses}
                  className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                >
                  {savingExpenses ? 'Guardando…' : t('common.add')}
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
      {section === 'ingresos' && (() => {
        // Prop Firm fields share state with the Depósitos and Retiros tabs:
        //   · ventas → `propFirmAmount` (writes to prop_firm_sales table)
        //   · retiros → withdrawals row with category='prop_firm'
        // Editing here updates the same source — when the Orion CRM API goes
        // live the inputs become read-only / API-driven without changing the
        // schema, since `summary.propFirmNetIncome` already feeds resumen-
        // general and admin-home off the same fields.
        const propFirmWithdrawal =
          withdrawals.find(w => w.category === 'prop_firm')?.amount || 0;
        const propFirmNet = propFirmAmount - propFirmWithdrawal;
        const totalIngresos = income.broker_pnl + income.other + propFirmNet;
        return (
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

            {/* Prop Firm — manual entry while the Orion CRM endpoint is not
                yet live. Net flows into Total Ingresos below. Mirror of the
                same fields visible in Depósitos (ventas) and Retiros
                (retiros), wired to the same state. */}
            <div className="pt-3 border-t border-border">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold">Prop Firm</h3>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/50 px-2 py-0.5 rounded">
                  manual · pendiente Orion CRM
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">Ventas Prop Firm</label>
                  {userCanAdd ? (
                    <input
                      type="number" step="0.01"
                      value={propFirmAmount || ''}
                      onChange={e => {
                        setPropFirmAmount(parseFloat(e.target.value) || 0);
                        markDirty('ingresos');
                      }}
                      className="w-full px-3 py-2 rounded-lg border border-border text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
                      placeholder="0.00"
                    />
                  ) : (
                    <p className="text-lg font-bold">{formatCurrency(propFirmAmount)}</p>
                  )}
                </div>
                <div>
                  <label className="text-sm text-muted-foreground mb-1 block">Retiros Prop Firm</label>
                  {userCanAdd ? (
                    <input
                      type="number" step="0.01"
                      value={propFirmWithdrawal || ''}
                      onChange={e => {
                        const v = parseFloat(e.target.value) || 0;
                        // setWithdrawals also marks 'retiros' dirty internally;
                        // we override to 'ingresos' below so the unsaved-banner
                        // shows in this tab where the user is actually working.
                        setWithdrawals(prev => prev.map(w =>
                          w.category === 'prop_firm' ? { ...w, amount: v } : w,
                        ));
                        markDirty('ingresos');
                      }}
                      className="w-full px-3 py-2 rounded-lg border border-border text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent"
                      placeholder="0.00"
                    />
                  ) : (
                    <p className="text-lg font-bold">{formatCurrency(propFirmWithdrawal)}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-end mt-2 text-sm">
                <span className="text-muted-foreground mr-2">Resultado Prop Firm:</span>
                <span className={`font-semibold ${propFirmNet < 0 ? 'text-red-600 dark:text-red-400' : ''}`}>
                  {formatCurrency(propFirmNet)}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between pt-4 border-t border-border">
              <div>
                <p className="text-sm text-muted-foreground">Total Ingresos</p>
                <p className="text-xl font-bold">{formatCurrency(totalIngresos)}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Broker P&amp;L + Otros + (Ventas Prop Firm − Retiros Prop Firm)
                </p>
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
        );
      })()}

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
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium" title="Depósito">+</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium" title="Retiro">−</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('upload.balance')}</th>
                  {(userCanEdit || userCanDelete) && <th className="w-24 text-center py-2 px-3 text-muted-foreground font-medium">{t('common.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {filteredLiquidity.length === 0 && (
                  <tr><td colSpan={7} className="py-8 text-center text-muted-foreground">{t('upload.noLiquidity')}</td></tr>
                )}
                {pagedLiquidity.map(row => (
                  <tr key={row.id} className="border-b border-border/50 hover:bg-muted/50">
                    {editingLiqId === row.id ? (
                      <>
                        <td className="py-2 px-3"><input type="date" aria-label="Fecha" value={editLiq.date} onChange={e => setEditLiq(p => ({ ...p, date: e.target.value }))} className="px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input aria-label="Usuario" value={editLiq.user_email} onChange={e => setEditLiq(p => ({ ...p, user_email: e.target.value }))} className="w-full px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input aria-label="Cuenta MT" value={editLiq.mt_account} onChange={e => setEditLiq(p => ({ ...p, mt_account: e.target.value }))} className="w-full px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input type="number" step="0.01" aria-label="Depósito" value={editLiq.deposit} onChange={e => setEditLiq(p => ({ ...p, deposit: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input type="number" step="0.01" aria-label="Retiro" value={editLiq.withdrawal} onChange={e => setEditLiq(p => ({ ...p, withdrawal: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3 text-right text-muted-foreground">{formatCurrency(liqBalanceMap.get(row.id) ?? 0)}</td>
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
                        <td className="py-2.5 px-3 text-right font-bold">{formatCurrency(liqBalanceMap.get(row.id) ?? 0)}</td>
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

          <PaginationControls
            page={liquidityPage}
            totalPages={liquidityTotalPages}
            totalItems={filteredLiquidity.length}
            onChange={setLiquidityPage}
          />

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
                  disabled={!newLiq.date || !newLiq.user_email || savingLiq}
                  className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                >
                  {savingLiq ? 'Guardando…' : t('common.add')}
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
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium" title="Depósito">+</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium" title="Retiro">−</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('upload.profit')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('upload.balance')}</th>
                  {(userCanEdit || userCanDelete) && <th className="w-24 text-center py-2 px-3 text-muted-foreground font-medium">{t('common.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {filteredInvestments.length === 0 && (
                  <tr><td colSpan={8} className="py-8 text-center text-muted-foreground">{t('upload.noInvestments')}</td></tr>
                )}
                {pagedInvestments.map(row => (
                  <tr key={row.id} className="border-b border-border/50 hover:bg-muted/50">
                    {editingInvId === row.id ? (
                      <>
                        <td className="py-2 px-3"><input type="date" aria-label="Fecha" value={editInv.date} onChange={e => setEditInv(p => ({ ...p, date: e.target.value }))} className="px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input aria-label="Concepto" value={editInv.concept} onChange={e => setEditInv(p => ({ ...p, concept: e.target.value }))} className="w-full px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input aria-label="Responsable" value={editInv.responsible} onChange={e => setEditInv(p => ({ ...p, responsible: e.target.value }))} className="w-full px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input type="number" step="0.01" aria-label="Depósito" value={editInv.deposit} onChange={e => setEditInv(p => ({ ...p, deposit: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input type="number" step="0.01" aria-label="Retiro" value={editInv.withdrawal} onChange={e => setEditInv(p => ({ ...p, withdrawal: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3"><input type="number" step="0.01" aria-label="Ganancia" value={editInv.profit} onChange={e => setEditInv(p => ({ ...p, profit: e.target.value }))} className="w-full text-right px-2 py-1 rounded border border-border text-sm" /></td>
                        <td className="py-2 px-3 text-right text-muted-foreground">{formatCurrency(invBalanceMap.get(row.id) ?? 0)}</td>
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
                        <td className="py-2.5 px-3 text-right font-bold">{formatCurrency(invBalanceMap.get(row.id) ?? 0)}</td>
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

          <PaginationControls
            page={investmentsPage}
            totalPages={investmentsTotalPages}
            totalItems={filteredInvestments.length}
            onChange={setInvestmentsPage}
          />

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
                  disabled={!newInv.date || savingInv}
                  className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
                >
                  {savingInv ? 'Guardando…' : t('common.add')}
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
            <input ref={fileRef} type="file" aria-label="Subir documento" onChange={handleDocUpload} className="hidden" />
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
        {userCanAdd && section !== 'documentos' && section !== 'liquidez' && section !== 'inversiones' && (
          <div className="flex items-center gap-3">
            {savingAll ? (
              <span
                className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-400 whitespace-nowrap"
                aria-live="polite"
                title="Guardando automáticamente"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-sky-500 animate-pulse" />
                Guardando…
              </span>
            ) : dirtySections.has(section) ? (
              <span
                className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 whitespace-nowrap"
                aria-live="polite"
                title="Hay cambios sin guardar — se guardarán automáticamente en 3 segundos"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                Guardando en 3 s…
              </span>
            ) : lastSavedAt ? (
              <SavedRecentlyBadge at={lastSavedAt} />
            ) : null}
            <button
              onClick={saveAll}
              disabled={savingAll}
              className="flex items-center justify-center gap-2 px-4 sm:px-6 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50 transition-colors shadow-sm"
              title="Guardar ahora sin esperar al auto-save"
            >
              <Save className="w-4 h-4" />
              {savingAll ? 'Guardando…' : 'Guardar ahora'}
            </button>
          </div>
        )}
      </div>

      {ConfirmModal}
      {ToastHost}
    </div>
  );
}
