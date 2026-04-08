'use client';

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
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

  // Refresh function
  refresh: () => Promise<void>;
}

const DataContext = createContext<DataContextValue | null>(null);

// ─── Provider ───

export function DataProvider({ children }: { children: ReactNode }) {
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

  // ─── Fetch all data ───

  const loadAllData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      // Step 1: fetch company
      const comp = await fetchCompany('vexprofx');
      if (!comp) {
        setError('No se encontró la empresa');
        setLoading(false);
        return;
      }
      setCompany(comp);

      // Step 2: fetch periods first (needed for periodIds)
      const pds = await fetchPeriods(comp.id);
      setPeriods(pds);

      // Step 3: fetch all other data in parallel
      const [
        deps,
        wdrs,
        exps,
        expTpls,
        preExps,
        opInc,
        brkBal,
        finSts,
        ptns,
        ptnDist,
        pfs,
        p2p,
        liq,
        inv,
        emps,
        cProfiles,
        mResults,
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
        fetchEmployees(comp.id),
        fetchCommercialProfiles(comp.id),
        fetchCommercialMonthlyResults(comp.id),
      ]);

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
      setEmployees(emps);
      setCommercialProfiles(cProfiles);
      setMonthlyResults(mResults);
    } catch (err) {
      console.error('Error loading data:', err);
      setError(err instanceof Error ? err.message : 'Error desconocido al cargar datos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  // ─── Saldo start period: March 2026 (year=2026, month=3) ───

  // Saldo chain applies from the first period onwards (all periods)
  const saldoStartIndex = useMemo(() => {
    return periods.length > 0 ? 0 : -1;
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

      refresh: loadAllData,
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
      loadAllData,
    ]
  );

  if (loading) {
    return (
      <DataContext.Provider value={value}>
        <div className="flex h-full items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">Cargando datos...</p>
          </div>
        </div>
      </DataContext.Provider>
    );
  }

  if (error) {
    return (
      <DataContext.Provider value={value}>
        <div className="flex h-full items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-center max-w-md">
            <p className="text-sm text-destructive font-medium">Error al cargar datos</p>
            <p className="text-xs text-muted-foreground">{error}</p>
            <button
              onClick={loadAllData}
              className="mt-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
            >
              Reintentar
            </button>
          </div>
        </div>
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
