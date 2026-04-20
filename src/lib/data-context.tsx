'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useAuth } from '@/lib/auth-context';
import {
  getActiveCompanyId,
  subscribeActiveCompanyId,
} from '@/lib/active-company';
import type {
  Company,
  Period,
  Deposit,
  Withdrawal,
  PropFirmSale,
  P2PTransfer,
  Expense,
  ExpenseTemplate,
  PreoperativeExpense,
  OperatingIncome,
  BrokerBalance,
  FinancialStatus,
  Partner,
  PartnerDistribution,
  LiquidityMovement,
  Investment,
  PeriodSummary,
  Employee,
  CommercialProfile,
  CommercialMonthlyResult,
} from './types';
import {
  fetchCompany,
  fetchCompanyById,
  fetchPeriods,
  fetchDeposits,
  fetchWithdrawals,
  fetchExpenses,
  fetchExpenseTemplates,
  fetchPreoperativeExpenses,
  fetchOperatingIncome,
  fetchBrokerBalance,
  fetchFinancialStatus,
  fetchPartners,
  fetchPartnerDistributions,
  fetchPropFirmSales,
  fetchP2PTransfers,
  fetchLiquidityMovements,
  fetchInvestments,
  fetchEmployees,
  fetchCommercialProfiles,
  fetchCommercialMonthlyResults,
} from './supabase/queries';
import { LoadingScreen, LoadingError } from '@/components/loading-screen';

// Max time we'll wait for the initial data load before showing an error
// with a retry button. Prevents the UI from getting stuck "loading..." forever.
const LOAD_TIMEOUT_MS = 60000;
const MAX_RETRIES = 2; // total attempts (1 initial + 1 retry)

// ─── Saldo Info (replicated from demo-data.ts) ───

export interface SaldoInfo {
  egresosNetos: number;
  saldoAnterior: number;
  saldoUsado: number;
  saldoNuevo: number;
  totalDistribuir: number;
}

// ─── Context Value ───

export interface DataContextValue {
  loading: boolean;
  error: string | null;
  company: Company | null;
  periods: Period[];

  // Core data getter functions
  getPeriodSummary: (periodId: string) => PeriodSummary | null;
  getConsolidatedSummary: (periodIds: string[]) => PeriodSummary | null;
  getLiquidityData: () => LiquidityMovement[];
  getInvestmentsData: () => Investment[];
  computeSaldoChain: () => Map<string, SaldoInfo>;
  isPeriodAfterSaldoStart: (periodId: string) => boolean;

  // Direct data access
  partners: Partner[];
  partnerDistributions: PartnerDistribution[];
  preoperativeExpenses: PreoperativeExpense[];
  expenseTemplates: ExpenseTemplate[];
  allExpenses: Expense[];
  allDeposits: Deposit[];
  allWithdrawals: Withdrawal[];
  allOperatingIncome: OperatingIncome[];
  allBrokerBalance: BrokerBalance[];
  allFinancialStatus: FinancialStatus[];
  allPropFirmSales: PropFirmSale[];
  allP2PTransfers: P2PTransfer[];

  // HR data
  employees: Employee[];
  commercialProfiles: CommercialProfile[];
  monthlyResults: CommercialMonthlyResult[];

  // HR helper functions
  getProfilesByHead: (headId: string | null) => CommercialProfile[];
  getMonthlyResults: (profileId: string) => CommercialMonthlyResult[];
  getResultsByPeriod: (periodId: string) => CommercialMonthlyResult[];
  getProfileById: (id: string) => CommercialProfile | undefined;
  getTotalCommissions: (profileId: string) => number;
  getPreviousPeriodResults: (periodId: string) => CommercialMonthlyResult[];

  // Refresh functions
  refresh: () => Promise<void>;
  refreshCommissions: () => Promise<void>;
  patchMonthlyResults: (updates: CommercialMonthlyResult[]) => void;
}

const DataContext = createContext<DataContextValue | null>(null);

// ─── Provider ───

export function DataProvider({ children }: { children: ReactNode }) {
  const { user: authUser } = useAuth();

  // For a superadmin, the "active company" is the one they navigated into
  // from /superadmin. Stored in localStorage (see src/lib/active-company.ts).
  // Regular users always use their own `company_id`.
  const [activeCompanyId, setActiveCompanyIdState] = useState<string | null>(() => getActiveCompanyId());

  useEffect(() => {
    const unsub = subscribeActiveCompanyId((next) => setActiveCompanyIdState(next));
    return unsub;
  }, []);

  // The company_id that should drive all data loads.
  //   - Superadmin: whatever company they're currently viewing (or null when
  //     they're on /superadmin without having entered an entity yet).
  //   - Regular user: their own membership.
  const effectiveCompanyId: string | null = authUser?.is_superadmin
    ? activeCompanyId
    : authUser?.company_id ?? null;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Core data
  const [company, setCompany] = useState<Company | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [deposits, setDeposits] = useState<Deposit[]>([]);
  const [withdrawals, setWithdrawals] = useState<Withdrawal[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expenseTemplates, setExpenseTemplates] = useState<ExpenseTemplate[]>([]);
  const [preoperativeExpenses, setPreoperativeExpenses] = useState<PreoperativeExpense[]>([]);
  const [operatingIncome, setOperatingIncome] = useState<OperatingIncome[]>([]);
  const [brokerBalance, setBrokerBalance] = useState<BrokerBalance[]>([]);
  const [financialStatus, setFinancialStatus] = useState<FinancialStatus[]>([]);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnerDistributions, setPartnerDistributions] = useState<PartnerDistribution[]>([]);
  const [propFirmSales, setPropFirmSales] = useState<PropFirmSale[]>([]);
  const [p2pTransfers, setP2PTransfers] = useState<P2PTransfer[]>([]);
  const [liquidityMovements, setLiquidityMovements] = useState<LiquidityMovement[]>([]);
  const [investments, setInvestments] = useState<Investment[]>([]);

  // HR data
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [commercialProfiles, setCommercialProfiles] = useState<CommercialProfile[]>([]);
  const [monthlyResults, setMonthlyResults] = useState<CommercialMonthlyResult[]>([]);

  // Monotonic counter used to ignore results from stale loadAllData() calls.
  // If the user triggers a new load while a previous one is still in-flight,
  // only the newest call's results get committed — prevents "flash of old data".
  const loadGenerationRef = useRef(0);

  // ─── Fetch all data ───

  // Fetches everything. If `silent` is true, the UI stays mounted and we
  // only update state in place — used for post-mutation refreshes so the
  // user doesn't lose scroll position, tab selection, or any local state.
  const loadAllData = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    // Bump the generation so any still-in-flight previous call's results
    // get discarded when they eventually resolve.
    const generation = ++loadGenerationRef.current;
    const isStale = () => loadGenerationRef.current !== generation;

    if (!silent) {
      setLoading(true);
      setError(null);
    }

    // ── Stage 1: critical data (with timeout) ──
    // These are the tables needed for the UI to render immediately.
    const fetchCritical = async () => {
      // Superadmin on /superadmin (no company chosen yet) → skip data load.
      // The DataProvider still renders, but `company` is null so downstream
      // pages that need company data should guard accordingly.
      if (!effectiveCompanyId) {
        if (isStale()) return null;
        setCompany(null);
        setPeriods([]);
        setEmployees([]);
        setCommercialProfiles([]);
        setMonthlyResults([]);
        return null;
      }

      const comp = await fetchCompanyById(effectiveCompanyId);
      if (!comp) throw new Error('No se encontró la empresa');
      if (isStale()) return null;
      setCompany(comp);

      const [pds, emps, cProfiles, mResults] = await Promise.all([
        fetchPeriods(comp.id),
        fetchEmployees(comp.id),
        fetchCommercialProfiles(comp.id),
        fetchCommercialMonthlyResults(comp.id),
      ]);

      if (isStale()) return null;
      setPeriods(pds);
      setEmployees(emps);
      setCommercialProfiles(cProfiles);
      setMonthlyResults(mResults);

      return comp;
    };

    // ── Stage 2: remaining data (background, no timeout) ──
    const fetchRest = async (comp: { id: string }) => {
      try {
        const [
          deps, wdrs, exps, expTpls, preExps, opInc,
          brkBal, finSts, ptns, ptnDist, pfs, p2p, liq, inv,
        ] = await Promise.all([
          fetchDeposits(comp.id),
          fetchWithdrawals(comp.id),
          fetchExpenses(comp.id),
          fetchExpenseTemplates(comp.id),
          fetchPreoperativeExpenses(comp.id),
          fetchOperatingIncome(comp.id),
          fetchBrokerBalance(comp.id),
          fetchFinancialStatus(comp.id),
          fetchPartners(comp.id),
          fetchPartnerDistributions(comp.id),
          fetchPropFirmSales(comp.id),
          fetchP2PTransfers(comp.id),
          fetchLiquidityMovements(comp.id),
          fetchInvestments(comp.id),
        ]);

        if (isStale()) return;
        setDeposits(deps);
        setWithdrawals(wdrs);
        setExpenses(exps);
        setExpenseTemplates(expTpls);
        setPreoperativeExpenses(preExps);
        setOperatingIncome(opInc);
        setBrokerBalance(brkBal);
        setFinancialStatus(finSts);
        setPartners(ptns);
        setPartnerDistributions(ptnDist);
        setPropFirmSales(pfs);
        setP2PTransfers(p2p);
        setLiquidityMovements(liq);
        setInvestments(inv);
      } catch (err) {
        // Background stage — don't break the UI, just log
        console.warn('Background data load failed (non-critical):', err);
      }
    };

    // Retry loop with timeout — only for critical stage
    let lastError: unknown = null;
    let comp: { id: string } | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (isStale()) return;

      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('La carga tardó demasiado. Verifica tu conexión e intenta de nuevo.')),
          LOAD_TIMEOUT_MS
        );
      });

      try {
        comp = await Promise.race([fetchCritical(), timeoutPromise]);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (isStale()) return;
        console.warn(`Data load attempt ${attempt}/${MAX_RETRIES} failed:`, err);
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1500));
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    // Critical stage done — show UI immediately
    if (!silent && !isStale()) {
      setLoading(false);
    }

    if (lastError) {
      if (isStale()) return;
      console.error('Error loading data after retries:', lastError);
      const msg =
        lastError instanceof Error ? lastError.message : 'Error desconocido al cargar datos';
      if (!silent) {
        setError(msg);
      } else {
        console.warn('Silent refresh failed, keeping existing data:', msg);
      }
      return;
    }

    // Load remaining data in background (no timeout)
    if (comp) {
      fetchRest(comp);
    }
  }, [effectiveCompanyId]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  // ─── Saldo chain start ───
  //
  // Historical behavior: the saldo chain starts at the FIRST period in the
  // list. Data up to March 2026 has already been manually reconciled and is
  // considered immutable — touching `saldoStartIndex` would re-chain those
  // months with today's formulas and drift away from the consolidated
  // numbers, so we intentionally leave the start at index 0.
  //
  // If in the future you want to cut the chain off (for a fresh epoch),
  // change `SALDO_START_YM` below to the YYYY-MM of the new starting period
  // — the effect is that earlier periods stop contributing to the chain.
  const SALDO_START_YM = null as string | null; // e.g. '2026-03' to cut over
  const saldoStartIndex = useMemo(() => {
    if (periods.length === 0) return -1;
    const cutoff: string | null = SALDO_START_YM;
    if (!cutoff) return 0;
    const idx = periods.findIndex(p => {
      const ym = `${p.year}-${String(p.month).padStart(2, '0')}`;
      return ym >= cutoff;
    });
    return idx >= 0 ? idx : 0;
  }, [periods]);

  const isPeriodAfterSaldoStart = useCallback(
    (periodId: string): boolean => {
      if (saldoStartIndex < 0) return false;
      const periodIdx = periods.findIndex(p => p.id === periodId);
      return periodIdx >= saldoStartIndex;
    },
    [periods, saldoStartIndex]
  );

  // ─── Saldo chain computation ───

  const computeSaldoChain = useCallback((): Map<string, SaldoInfo> => {
    const chain = new Map<string, SaldoInfo>();
    let saldoAcumulado = 0;

    // Pre-index for O(1) lookups
    const oiIndex = new Map(operatingIncome.map(o => [o.period_id, o]));
    const pfsIndex = new Map(propFirmSales.map(p => [p.period_id, p]));
    const pfwIndex = new Map<string, number>();
    for (const w of withdrawals) {
      if (w.category === 'prop_firm') pfwIndex.set(w.period_id, w.amount);
    }
    // Pre-index expenses totals per period
    const expIndex = new Map<string, number>();
    for (const e of expenses) {
      expIndex.set(e.period_id, (expIndex.get(e.period_id) || 0) + e.amount);
    }

    for (const period of periods) {
      if (!isPeriodAfterSaldoStart(period.id)) continue;

      const oi = oiIndex.get(period.id);
      const egresosNetos = expIndex.get(period.id) || 0;
      // Prop Firm net income = sales - withdrawals
      const pfs = pfsIndex.get(period.id)?.amount || 0;
      const pfW = pfwIndex.get(period.id) || 0;
      const propFirmNet = pfs - pfW;
      const ingresosNetos = (oi ? oi.broker_pnl + oi.other : 0) + propFirmNet;

      // Net balance: income minus expenses
      const netBalance = ingresosNetos - egresosNetos;

      const saldoAnterior = saldoAcumulado;
      let saldoUsado = 0;
      let totalDistribuir = ingresosNetos;

      if (netBalance < 0) {
        const deficit = Math.abs(netBalance);
        if (saldoAnterior >= deficit) {
          saldoUsado = deficit;
        } else {
          saldoUsado = saldoAnterior;
          const remaining = deficit - saldoAnterior;
          totalDistribuir = ingresosNetos - remaining;
        }
        saldoAcumulado = saldoAnterior - saldoUsado;
      } else if (netBalance > 0) {
        saldoAcumulado = saldoAnterior + netBalance;
      }

      chain.set(period.id, {
        egresosNetos,
        saldoAnterior,
        saldoUsado,
        saldoNuevo: saldoAcumulado,
        totalDistribuir,
      });
    }

    return chain;
  }, [periods, expenses, operatingIncome, propFirmSales, withdrawals, isPeriodAfterSaldoStart]);

  // ─── Period summary (single) ───

  const getPeriodSummary = useCallback(
    (periodId: string): PeriodSummary | null => {
      const period = periods.find(p => p.id === periodId);
      if (!period) return null;

      const periodDeposits = deposits.filter(d => d.period_id === periodId);
      const periodWithdrawals = withdrawals.filter(w => w.period_id === periodId);
      const periodExpenses = expenses.filter(e => e.period_id === periodId);
      const propFirmSale = propFirmSales.find(p => p.period_id === periodId);
      const p2pTransfer = p2pTransfers.find(p => p.period_id === periodId);
      const oi = operatingIncome.find(o => o.period_id === periodId) || null;
      const bb = brokerBalance.find(b => b.period_id === periodId) || null;
      const fs = financialStatus.find(f => f.period_id === periodId) || null;

      const totalDeposits = periodDeposits.reduce((sum, d) => sum + d.amount, 0);
      const totalWithdrawals = periodWithdrawals.reduce((sum, w) => sum + w.amount, 0);
      const pfs = propFirmSale?.amount || 0;
      const p2p = p2pTransfer?.amount || 0;
      const propFirmWithdrawal = periodWithdrawals.find(w => w.category === 'prop_firm')?.amount || 0;
      const propFirmNetIncome = pfs - propFirmWithdrawal;

      return {
        period,
        totalDeposits,
        totalWithdrawals,
        netDeposit: totalDeposits - totalWithdrawals,
        propFirmSales: pfs,
        propFirmNetIncome,
        brokerDeposits: totalDeposits - pfs,
        p2pTransfer: p2p,
        totalExpenses: periodExpenses.reduce((sum, e) => sum + e.amount, 0),
        totalExpensesPaid: periodExpenses.reduce((sum, e) => sum + e.paid, 0),
        totalExpensesPending: periodExpenses.reduce((sum, e) => sum + e.pending, 0),
        operatingIncome: oi,
        brokerBalance: bb,
        financialStatus: fs,
        deposits: periodDeposits,
        withdrawals: periodWithdrawals,
        expenses: periodExpenses,
      };
    },
    [periods, deposits, withdrawals, expenses, propFirmSales, p2pTransfers, operatingIncome, brokerBalance, financialStatus]
  );

  // ─── Consolidated summary ───

  const getConsolidatedSummary = useCallback(
    (periodIds: string[]): PeriodSummary | null => {
      if (periodIds.length === 0) return null;
      if (periodIds.length === 1) return getPeriodSummary(periodIds[0]);

      const matchedPeriods = periods.filter(p => periodIds.includes(p.id));
      if (matchedPeriods.length === 0) return null;

      const firstPeriod = matchedPeriods[0];
      const lastPeriod = matchedPeriods[matchedPeriods.length - 1];

      const allDeps = deposits.filter(d => periodIds.includes(d.period_id));
      const allWdrs = withdrawals.filter(w => periodIds.includes(w.period_id));
      const allExps = expenses.filter(e => periodIds.includes(e.period_id));

      // Consolidate deposits by channel
      const channels: Array<'coinsbuy' | 'fairpay' | 'unipayment' | 'other'> = [
        'coinsbuy',
        'fairpay',
        'unipayment',
        'other',
      ];
      const consolidatedDeposits: Deposit[] = channels.map((ch) => ({
        id: `cons-d-${ch}`,
        period_id: 'consolidated',
        company_id: firstPeriod.company_id,
        channel: ch,
        amount: allDeps.filter(d => d.channel === ch).reduce((s, d) => s + d.amount, 0),
        notes: null,
      }));

      const categories: Array<'ib_commissions' | 'broker' | 'prop_firm' | 'other'> = [
        'ib_commissions',
        'broker',
        'prop_firm',
        'other',
      ];
      const consolidatedWithdrawals: Withdrawal[] = categories.map((cat) => ({
        id: `cons-w-${cat}`,
        period_id: 'consolidated',
        company_id: firstPeriod.company_id,
        category: cat,
        amount: allWdrs.filter(w => w.category === cat).reduce((s, w) => s + w.amount, 0),
        notes: null,
      }));

      const totalDeposits = consolidatedDeposits.reduce((s, d) => s + d.amount, 0);
      const totalWithdrawals = consolidatedWithdrawals.reduce((s, w) => s + w.amount, 0);
      const pfs = propFirmSales
        .filter(p => periodIds.includes(p.period_id))
        .reduce((s, p) => s + p.amount, 0);
      const propFirmWithdrawal = consolidatedWithdrawals.find(w => w.category === 'prop_firm')?.amount || 0;
      const propFirmNetIncome = pfs - propFirmWithdrawal;
      const p2p = p2pTransfers
        .filter(p => periodIds.includes(p.period_id))
        .reduce((s, p) => s + p.amount, 0);

      const incomes = operatingIncome.filter(oi => periodIds.includes(oi.period_id));
      const consolidatedIncome: OperatingIncome = {
        id: 'cons-oi',
        period_id: 'consolidated',
        company_id: firstPeriod.company_id,
        prop_firm: incomes.reduce((s, i) => s + i.prop_firm, 0),
        broker_pnl: incomes.reduce((s, i) => s + i.broker_pnl, 0),
        other: incomes.reduce((s, i) => s + i.other, 0),
      };

      const brokers = brokerBalance.filter(bb => periodIds.includes(bb.period_id));
      const consolidatedBroker: BrokerBalance = {
        id: 'cons-bb',
        period_id: 'consolidated',
        company_id: firstPeriod.company_id,
        pnl_book_b: brokers.reduce((s, b) => s + b.pnl_book_b, 0),
        liquidity_commissions: brokers.reduce((s, b) => s + b.liquidity_commissions, 0),
      };

      const firstFs = financialStatus.find(fs => fs.period_id === firstPeriod.id);
      const allFs = financialStatus.filter(fs => periodIds.includes(fs.period_id));

      const sumOperatingExpensesPaid = allFs.reduce((s, f) => s + f.operating_expenses_paid, 0);
      const sumNetTotal = allFs.reduce((s, f) => s + f.net_total, 0);
      const startingBalance = firstFs?.previous_month_balance || 0;

      const consolidatedFs: FinancialStatus = {
        id: 'cons-fs',
        period_id: 'consolidated',
        company_id: firstPeriod.company_id,
        operating_expenses_paid: sumOperatingExpensesPaid,
        net_total: sumNetTotal,
        previous_month_balance: startingBalance,
        current_month_balance: startingBalance + sumNetTotal,
      };

      const consolidatedPeriod: Period = {
        id: 'consolidated',
        company_id: firstPeriod.company_id,
        year: lastPeriod.year,
        month: lastPeriod.month,
        label: `${firstPeriod.label} — ${lastPeriod.label}`,
        is_closed: false,
        reserve_pct: 0.10,
      };

      return {
        period: consolidatedPeriod,
        totalDeposits,
        totalWithdrawals,
        netDeposit: totalDeposits - totalWithdrawals,
        propFirmSales: pfs,
        propFirmNetIncome,
        brokerDeposits: totalDeposits - pfs,
        p2pTransfer: p2p,
        totalExpenses: allExps.reduce((s, e) => s + e.amount, 0),
        totalExpensesPaid: allExps.reduce((s, e) => s + e.paid, 0),
        totalExpensesPending: allExps.reduce((s, e) => s + e.pending, 0),
        operatingIncome: consolidatedIncome,
        brokerBalance: consolidatedBroker,
        financialStatus: consolidatedFs,
        deposits: consolidatedDeposits,
        withdrawals: consolidatedWithdrawals,
        expenses: allExps,
      };
    },
    [periods, deposits, withdrawals, expenses, propFirmSales, p2pTransfers, operatingIncome, brokerBalance, financialStatus, getPeriodSummary]
  );

  // ─── Liquidity and investments getters ───

  const getLiquidityData = useCallback(
    (): LiquidityMovement[] => liquidityMovements,
    [liquidityMovements]
  );

  const getInvestmentsData = useCallback(
    (): Investment[] => investments,
    [investments]
  );

  // ─── HR helpers ───

  const getProfilesByHead = useCallback(
    (headId: string | null): CommercialProfile[] => {
      if (headId === null) return [];
      return commercialProfiles.filter(p => p.head_id === headId);
    },
    [commercialProfiles]
  );

  const getMonthlyResultsFn = useCallback(
    (profileId: string): CommercialMonthlyResult[] => {
      return monthlyResults.filter(r => r.profile_id === profileId);
    },
    [monthlyResults]
  );

  const getResultsByPeriod = useCallback(
    (periodId: string): CommercialMonthlyResult[] => {
      return monthlyResults.filter(r => r.period_id === periodId);
    },
    [monthlyResults]
  );

  const getProfileById = useCallback(
    (id: string): CommercialProfile | undefined => {
      return commercialProfiles.find(p => p.id === id);
    },
    [commercialProfiles]
  );

  const getTotalCommissions = useCallback(
    (profileId: string): number => {
      return monthlyResults
        .filter(r => r.profile_id === profileId)
        .reduce((sum, r) => sum + r.total_earned, 0);
    },
    [monthlyResults]
  );

  const getPreviousPeriodResults = useCallback(
    (periodId: string): CommercialMonthlyResult[] => {
      const sorted = [...periods].sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
      const idx = sorted.findIndex(p => p.id === periodId);
      if (idx <= 0) return [];
      const prevPeriod = sorted[idx - 1];
      return monthlyResults.filter(r => r.period_id === prevPeriod.id);
    },
    [periods, monthlyResults]
  );

  // ─── Context value (memoized) ───

  const value = useMemo<DataContextValue>(
    () => ({
      loading,
      error,
      company,
      periods,

      getPeriodSummary,
      getConsolidatedSummary,
      getLiquidityData,
      getInvestmentsData,
      computeSaldoChain,
      isPeriodAfterSaldoStart,

      partners,
      partnerDistributions,
      preoperativeExpenses,
      expenseTemplates,
      allExpenses: expenses,
      allDeposits: deposits,
      allWithdrawals: withdrawals,
      allOperatingIncome: operatingIncome,
      allBrokerBalance: brokerBalance,
      allFinancialStatus: financialStatus,
      allPropFirmSales: propFirmSales,
      allP2PTransfers: p2pTransfers,

      employees,
      commercialProfiles,
      monthlyResults,

      getProfilesByHead,
      getMonthlyResults: getMonthlyResultsFn,
      getResultsByPeriod,
      getProfileById,
      getTotalCommissions,
      getPreviousPeriodResults,

      // `refresh` is silent by default: it re-fetches in the background
      // without unmounting children, so callers keep their scroll position,
      // active tab, open modals, etc.
      refresh: () => loadAllData({ silent: true }),

      // Lightweight refresh — only reloads commission-related tables (no timeout)
      refreshCommissions: async () => {
        try {
          const comp = company;
          if (!comp) return;
          // Solo recargar monthlyResults, los profiles no cambian al guardar comisiones
          const mResults = await fetchCommercialMonthlyResults(comp.id);
          setMonthlyResults(mResults);
        } catch (err) {
          console.warn('Error refreshing commissions:', err);
        }
      },

      // Actualiza monthlyResults localmente con los registros guardados
      // sin hacer fetch a Supabase — la UI se actualiza instantáneamente
      patchMonthlyResults: (updates: CommercialMonthlyResult[]) => {
        setMonthlyResults((prev) => {
          const next = [...prev];
          for (const update of updates) {
            const idx = next.findIndex(
              (r) => r.profile_id === update.profile_id
                && r.period_id === update.period_id
                && r.head_id === update.head_id
            );
            if (idx >= 0) {
              next[idx] = { ...next[idx], ...update };
            } else {
              next.push(update);
            }
          }
          return next;
        });
      },
    }),
    [
      loading,
      error,
      company,
      periods,
      getPeriodSummary,
      getConsolidatedSummary,
      getLiquidityData,
      getInvestmentsData,
      computeSaldoChain,
      isPeriodAfterSaldoStart,
      partners,
      partnerDistributions,
      preoperativeExpenses,
      expenseTemplates,
      expenses,
      deposits,
      withdrawals,
      operatingIncome,
      brokerBalance,
      financialStatus,
      propFirmSales,
      p2pTransfers,
      employees,
      commercialProfiles,
      monthlyResults,
      getProfilesByHead,
      getMonthlyResultsFn,
      getResultsByPeriod,
      getProfileById,
      getTotalCommissions,
      getPreviousPeriodResults,
      loadAllData,
    ]
  );

  // Only block the UI on the INITIAL load. Silent refreshes (triggered by
  // mutations via `refresh()`) keep children mounted so the user never
  // loses scroll position or any local state.
  if (loading) {
    return (
      <DataContext.Provider value={value}>
        <LoadingScreen />
      </DataContext.Provider>
    );
  }

  if (error) {
    return (
      <DataContext.Provider value={value}>
        <LoadingError message={error} onRetry={() => loadAllData()} />
      </DataContext.Provider>
    );
  }

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

// ─── Hook ───

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used within DataProvider');
  return ctx;
}
