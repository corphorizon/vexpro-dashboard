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
import { applyCompanyTheme, resetCompanyTheme } from '@/lib/theme-apply';
import type {
  Company,
  Period,
  Deposit,
  Withdrawal,
  PropFirmSale,
  P2PTransfer,
  Expense,
  ExpenseTemplate,
  ExpenseTemplateHidden,
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
  fetchCompanyById,
  fetchPeriods,
  fetchDeposits,
  fetchWithdrawals,
  fetchExpenses,
  fetchExpenseTemplates,
  fetchExpenseTemplateHidden,
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
import * as Sentry from '@sentry/nextjs';
import { LOAD_TIMEOUT_MS, LOAD_WATCHDOG_MS, LOAD_MAX_RETRIES } from '@/lib/config';
import { computeDistributionChain, type PeriodDistInput } from '@/lib/distribution';

// Magic numbers centralized in src/lib/config.ts (Sprint 3 quick win
// 2026-06-06). Tuning them no longer means grepping the codebase.
const MAX_RETRIES = LOAD_MAX_RETRIES;

// ─── Saldo Info (replicated from demo-data.ts) ───

// Deriva de la fórmula canónica compartida (src/lib/distribution.ts). Antes
// tenía un modelo divergente (saldoAnterior/saldoUsado/saldoNuevo con drenaje
// de acumulado) que contradecía a /socios — ver BUG-01. Ahora expone los
// campos canónicos (reserva-ahorro + deuda arrastrada + montoDistribuir).
export interface SaldoInfo {
  ingresosNetos: number;
  egresosNetos: number;
  saldoAFavor: number;
  deudaArrastradaEntrada: number;
  reserveThisPeriod: number;
  reserveAccumulated: number;
  deudaArrastradaSalida: number;
  montoDistribuir: number;
  /** Alias retro-compat = montoDistribuir (consumidores viejos). */
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
  expenseTemplateHidden: ExpenseTemplateHidden[];
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
  // `refresh()` returns `true` on success, `false` if the silent reload
  // failed (timeout, network error, RLS rejection). Callers can surface a
  // toast or fall back to a manual page reload prompt. Existing code that
  // doesn't care about the result can keep `void refresh()` — the boolean
  // is just informational, not thrown.
  refresh: () => Promise<boolean>;
  refreshCommissions: () => Promise<void>;
  // Refresh selectivo (B1, 2026-06-20): recarga SOLO las tablas de las
  // secciones indicadas en vez de las ~19 queries del refresh() completo.
  // Tras guardar egresos no hay razón para re-traer liquidez, inversiones,
  // socios, RRHH, etc. — con la DB en eu-west-2 (Dubai↔LatAm) eso era el
  // grueso de la espera percibida después de cada save/autosave.
  refreshSections: (
    sections: Array<'depositos' | 'retiros' | 'egresos' | 'ingresos' | 'liquidez' | 'inversiones'>,
  ) => Promise<boolean>;
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
  const [expenseTemplateHidden, setExpenseTemplateHidden] = useState<ExpenseTemplateHidden[]>([]);
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

  // Última company cuyos datos se cargaron. Permite distinguir "cambio
  // de empresa" (→ purgar datasets Stage-2 del tenant anterior) de un
  // simple retry/refresh de la misma empresa (→ conservar datos).
  // Sentinel inicial distinto de null para que el primer load también
  // registre la company sin tratar null (superadmin sin empresa) como
  // "ya cargada".
  const lastLoadedCompanyRef = useRef<string | null | undefined>(undefined);

  // ─── Fetch all data ───

  // Fetches everything. If `silent` is true, the UI stays mounted and we
  // only update state in place — used for post-mutation refreshes so the
  // user doesn't lose scroll position, tab selection, or any local state.
  const loadAllData = useCallback(async (options?: { silent?: boolean }): Promise<boolean> => {
    const silent = options?.silent ?? false;
    // Bump the generation so any still-in-flight previous call's results
    // get discarded when they eventually resolve.
    const generation = ++loadGenerationRef.current;
    const isStale = () => loadGenerationRef.current !== generation;

    Sentry.addBreadcrumb({
      category: 'data-context.load',
      message: 'loadAllData:start',
      data: { generation, silent, effectiveCompanyId },
    });

    if (!silent) {
      setLoading(true);
      setError(null);
    }

    // Watchdog — guaranteed escape hatch. If for ANY reason we don't
    // flip loading=false within LOAD_WATCHDOG_MS, do it ourselves and
    // surface an error so the user can retry. Covers paths we haven't
    // anticipated (orphan locks, stalled Supabase fetch, exceptions
    // outside the try/finally, etc.). Cleared on normal completion.
    let watchdogId: ReturnType<typeof setTimeout> | null = null;
    if (!silent) {
      watchdogId = setTimeout(() => {
        if (isStale()) return; // newer call will handle it
        console.error('[data-context] Watchdog fired — forcing loading=false');
        Sentry.captureMessage('data-context watchdog fired', {
          level: 'error',
          tags: { area: 'data-context.watchdog' },
          extra: { generation, effectiveCompanyId },
        });
        setError('La carga tardó más de lo esperado. Verifica tu conexión y vuelve a intentar.');
        setLoading(false);
      }, LOAD_WATCHDOG_MS);
    }

    // Limpia TODOS los datasets Stage-2. Se usa al cambiar de empresa:
    // sin esto, tras el splash los hijos montaban con los `periods`
    // NUEVOS pero allDeposits/allWithdrawals/etc. de la empresa
    // ANTERIOR hasta que fetchRest resolvía (auditoría multi-tenant
    // 2026-07-15 — ventana de fuga visual cross-tenant en viewing-as).
    const clearStageTwoData = () => {
      setDeposits([]);
      setWithdrawals([]);
      setExpenses([]);
      setExpenseTemplates([]);
      setExpenseTemplateHidden([]);
      setPreoperativeExpenses([]);
      setOperatingIncome([]);
      setBrokerBalance([]);
      setFinancialStatus([]);
      setPartners([]);
      setPartnerDistributions([]);
      setPropFirmSales([]);
      setP2PTransfers([]);
      setLiquidityMovements([]);
      setInvestments([]);
    };

    // Cambio de tenant detectado → purgar los datasets del anterior ANTES
    // de cargar. lastLoadedCompanyRef distingue "cambio de empresa" de
    // "retry de la misma" (un Reintentar no debe borrar datos válidos).
    if (lastLoadedCompanyRef.current !== effectiveCompanyId) {
      lastLoadedCompanyRef.current = effectiveCompanyId;
      clearStageTwoData();
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
        // Stage-2 ya se purgó arriba al detectar el cambio de tenant.
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
          deps, wdrs, exps, expTpls, expHidden, preExps, opInc,
          brkBal, finSts, ptns, ptnDist, pfs, p2p, liq, inv,
        ] = await Promise.all([
          fetchDeposits(comp.id),
          fetchWithdrawals(comp.id),
          fetchExpenses(comp.id),
          fetchExpenseTemplates(comp.id),
          fetchExpenseTemplateHidden(comp.id),
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
        setExpenseTemplateHidden(expHidden);
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

    // Retry loop with timeout — only for critical stage.
    //
    // Stale handling (Kevin reported 2026-06-06): the previous version
    // returned `false` whenever it detected `isStale()` and left
    // `setLoading(false)` un-called in that path. Two consecutive saves
    // (each triggering refresh()) bumped generation twice; the first
    // refresh ran to "stale → return false" and the caller showed a
    // bogus "no se pudo recargar" toast even though the second refresh
    // succeeded. Worse, on cold load a quick `effectiveCompanyId`
    // change (auth-context resolving null → uuid) made the initial
    // load go stale before it could flip loading=false, freezing the
    // splash forever.
    //
    // Fixed by treating stale as "not a failure — a newer call will
    // settle the UI". Stale returns `true` so callers don't surface
    // false negatives, and the final loading/error flip lives in a
    // single finally block that runs only for the latest generation.
    let lastError: unknown = null;
    let comp: { id: string } | null = null;
    let staleEarly = false;

    try {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (isStale()) { staleEarly = true; break; }

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
          if (isStale()) { staleEarly = true; break; }
          console.warn(`Data load attempt ${attempt}/${MAX_RETRIES} failed:`, err);
          if (attempt < MAX_RETRIES) {
            await new Promise((r) => setTimeout(r, 1500));
          }
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      }
    } finally {
      // Single source of truth for the loading/error flip. Runs for
      // EVERY exit path of the retry loop (success, error, stale,
      // unexpected throw). Only the latest generation gets to touch
      // visible state — stale generations bow out silently.
      if (!silent && !isStale()) {
        setLoading(false);
      }
      // Cancel the watchdog — we're done one way or another.
      if (watchdogId) clearTimeout(watchdogId);
      Sentry.addBreadcrumb({
        category: 'data-context.load',
        message: 'loadAllData:end',
        data: { generation, silent, stale: isStale(), hasError: !!lastError },
      });
    }

    // Stale: a newer loadAllData() is in flight and will produce the
    // final result. Don't show false-negative errors to callers.
    if (staleEarly) {
      return true;
    }

    if (lastError) {
      if (isStale()) return true;
      console.error('Error loading data after retries:', lastError);
      const msg =
        lastError instanceof Error ? lastError.message : 'Error desconocido al cargar datos';
      if (!silent) {
        setError(msg);
      } else {
        console.warn('Silent refresh failed, keeping existing data:', msg);
      }
      return false;
    }

    // Load remaining data in background (no timeout)
    if (comp) {
      fetchRest(comp);
    }
    return true;
  }, [effectiveCompanyId]);

  useEffect(() => {
    // Initial load — ignore the boolean return (success/failure already
    // surfaced via `loading` / `error` state above).
    void loadAllData();
  }, [loadAllData]);

  // Whenever `company` changes, push its brand colors into the live CSS
  // variables so every `var(--color-primary)` / `var(--color-secondary)`
  // in the UI picks them up without reloading. When the company becomes
  // null (superadmin on /superadmin), fall back to globals.css defaults.
  useEffect(() => {
    if (company) {
      applyCompanyTheme({
        primary: company.color_primary,
        secondary: company.color_secondary,
      });
    } else {
      resetCompanyTheme();
    }
  }, [company]);

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
    // Índices O(1) de las primitivas por período.
    const oiIndex = new Map(operatingIncome.map(o => [o.period_id, o]));
    const pfsIndex = new Map(propFirmSales.map(p => [p.period_id, p.amount]));
    const pfwIndex = new Map<string, number>();
    for (const w of withdrawals) {
      if (w.category === 'prop_firm') pfwIndex.set(w.period_id, w.amount);
    }
    const expIndex = new Map<string, number>();
    for (const e of expenses) {
      expIndex.set(e.period_id, (expIndex.get(e.period_id) || 0) + e.amount);
    }
    // investmentProfits por período — las inversiones son date-keyed (no
    // period_id): se asignan al período cuyo año/mes coincide con inv.date.
    // Misma lógica que getPeriodSummary.investmentProfits.
    const invIndex = new Map<string, number>();
    for (const inv of investments) {
      if (!inv.date) continue;
      const [y, m] = String(inv.date).split('-').map(Number);
      const per = periods.find(p => p.year === y && p.month === m);
      if (per) invIndex.set(per.id, (invIndex.get(per.id) || 0) + (Number(inv.profit) || 0));
    }

    // Construir inputs canónicos EN ORDEN sobre TODOS los períodos y delegar
    // en la fórmula única compartida (src/lib/distribution.ts). Correr la
    // cadena completa (no filtrada por saldoStart) garantiza que el arrastre
    // de deuda/reserva coincida con /socios.
    const inputs: PeriodDistInput[] = periods.map(period => {
      const oi = oiIndex.get(period.id);
      const pfs = pfsIndex.get(period.id) || 0;
      const pfW = pfwIndex.get(period.id) || 0;
      return {
        periodId: period.id,
        brokerPnl: oi?.broker_pnl || 0,
        other: oi?.other || 0,
        propFirmNetIncome: pfs - pfW,
        investmentProfits: invIndex.get(period.id) || 0,
        totalExpenses: expIndex.get(period.id) || 0,
        reservePct: period.reserve_pct,
      };
    });

    const canonical = computeDistributionChain(inputs);
    const chain = new Map<string, SaldoInfo>();
    for (const [pid, r] of canonical) {
      chain.set(pid, { ...r, totalDistribuir: r.montoDistribuir });
    }
    return chain;
  }, [periods, expenses, operatingIncome, propFirmSales, withdrawals, investments]);

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

      // Investment profits this month — sum `profit` of investments rows
      // whose `date` is within the period's calendar month. The investments
      // table is date-keyed (not period_id-keyed) so we match on year/month.
      const investmentProfits = investments.reduce((sum, inv) => {
        if (!inv.date) return sum;
        const [y, m] = String(inv.date).split('-').map(Number);
        if (y !== period.year || m !== period.month) return sum;
        return sum + (Number(inv.profit) || 0);
      }, 0);

      return {
        period,
        totalDeposits,
        totalWithdrawals,
        netDeposit: totalDeposits - totalWithdrawals,
        propFirmSales: pfs,
        propFirmNetIncome,
        investmentProfits,
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
    [periods, deposits, withdrawals, expenses, propFirmSales, p2pTransfers, operatingIncome, brokerBalance, financialStatus, investments]
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

      // Investment profits across all selected periods — sum `profit` for
      // investments whose date falls in any of the matched periods'
      // year/month. Same logic as single-period summary, expanded.
      const matchedYM = new Set(matchedPeriods.map(p => `${p.year}-${p.month}`));
      const investmentProfits = investments.reduce((sum, inv) => {
        if (!inv.date) return sum;
        const [y, m] = String(inv.date).split('-').map(Number);
        if (!matchedYM.has(`${y}-${m}`)) return sum;
        return sum + (Number(inv.profit) || 0);
      }, 0);

      return {
        period: consolidatedPeriod,
        totalDeposits,
        totalWithdrawals,
        netDeposit: totalDeposits - totalWithdrawals,
        propFirmSales: pfs,
        propFirmNetIncome,
        investmentProfits,
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
    [periods, deposits, withdrawals, expenses, propFirmSales, p2pTransfers, operatingIncome, brokerBalance, financialStatus, getPeriodSummary, investments]
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
      expenseTemplateHidden,
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
      //
      // Returns `true` on success, `false` if the silent reload failed
      // (timeout, network error, RLS rejection). Callers that care about
      // post-mutation freshness (e.g. /upload save handlers) can surface a
      // toast when the refresh fails so the user knows the screen may show
      // stale data; otherwise the boolean can be safely ignored.
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

      // Refresh selectivo — ver comentario en la interface. Cada sección
      // recarga solo sus tablas; 2-3 queries en vez de ~19. Devuelve el
      // mismo boolean-contrato que refresh() para que los callers de
      // /upload puedan mantener su manejo de errores intacto.
      refreshSections: async (sections) => {
        try {
          const comp = company;
          if (!comp) return false;
          const s = new Set(sections);
          const tasks: Promise<unknown>[] = [];
          if (s.has('depositos')) {
            tasks.push(fetchDeposits(comp.id).then(setDeposits));
            tasks.push(fetchPropFirmSales(comp.id).then(setPropFirmSales));
          }
          // 'ingresos' también persiste retiros (ver saveAll en /upload),
          // así que ambos refrescan withdrawals + p2p.
          if (s.has('retiros') || s.has('ingresos')) {
            tasks.push(fetchWithdrawals(comp.id).then(setWithdrawals));
            tasks.push(fetchP2PTransfers(comp.id).then(setP2PTransfers));
          }
          if (s.has('egresos')) {
            tasks.push(fetchExpenses(comp.id).then(setExpenses));
            tasks.push(fetchExpenseTemplates(comp.id).then(setExpenseTemplates));
            tasks.push(fetchExpenseTemplateHidden(comp.id).then(setExpenseTemplateHidden));
          }
          if (s.has('ingresos')) {
            tasks.push(fetchOperatingIncome(comp.id).then(setOperatingIncome));
            tasks.push(fetchPropFirmSales(comp.id).then(setPropFirmSales));
          }
          if (s.has('liquidez')) {
            tasks.push(fetchLiquidityMovements(comp.id).then(setLiquidityMovements));
          }
          if (s.has('inversiones')) {
            tasks.push(fetchInvestments(comp.id).then(setInvestments));
          }
          await Promise.all(tasks);
          return true;
        } catch (err) {
          console.warn('Error en refresh selectivo:', err);
          return false;
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
      expenseTemplateHidden,
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
        <LoadingScreen onRetry={() => void loadAllData()} />
      </DataContext.Provider>
    );
  }

  if (error) {
    return (
      <DataContext.Provider value={value}>
        <LoadingError message={error} onRetry={() => void loadAllData()} />
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
