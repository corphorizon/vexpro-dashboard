'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { useData } from '@/lib/data-context';
import { usePeriod } from '@/lib/period-context';
import { useAuth, hasModuleAccess, canAdd } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { formatCurrency } from '@/lib/utils';
import { upsertChannelBalance, pinCoinsbuyWallet, unpinCoinsbuyWallet } from '@/lib/supabase/mutations';
import { fetchChannelBalances, fetchPinnedCoinsbuyWallets } from '@/lib/supabase/queries';
import type { ChannelBalance, PinnedCoinsbuyWallet } from '@/lib/types';
import { isDerivedBrokerPeriod } from '@/lib/broker-logic';
import {
  Wallet,
  Calendar,
  RefreshCw,
  Save,
  TrendingUp,
  Droplets,
  Plug,
  Edit2,
  Check,
  X,
  AlertTriangle,
  ToggleLeft,
  ToggleRight,
  Pin,
  PinOff,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// Channel definitions
// ─────────────────────────────────────────────────────────────────────────────

interface ChannelDef {
  key: string;
  label: string;
  type: 'api' | 'manual' | 'auto';
  /** When true, the user can override the auto-fetched value with a manual
   *  snapshot. Used for channels where the API can fail and we still need
   *  a number shown (UniPayment). */
  allowManualOverride?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
  description?: string;
}

const CHANNELS: ChannelDef[] = [
  { key: 'coinsbuy',       label: 'Coinsbuy',                   type: 'auto',   icon: Plug,       description: 'Wallet VexPro Main — balance en tiempo real' },
  { key: 'unipayment',     label: 'UniPayment',                 type: 'auto',   allowManualOverride: true, icon: Plug, description: 'My Wallet — balance en tiempo real (editable como respaldo)' },
  { key: 'fairpay',        label: 'FairPay',                    type: 'manual',                    description: 'Ingreso manual' },
  { key: 'wallet_externa', label: 'Wallet Externa',             type: 'manual',                    description: 'Ingreso manual' },
  { key: 'otros',          label: 'Otros',                      type: 'manual',                    description: 'Ingreso manual' },
  { key: 'inversiones',    label: 'Balance Actual Inversiones', type: 'auto',   icon: TrendingUp, description: 'Automático desde módulo Inversiones' },
  { key: 'liquidez',       label: 'Balance Actual Liquidez',    type: 'auto',   icon: Droplets,   description: 'Automático desde módulo Liquidez' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

export default function BalancesPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { company, periods, getPeriodSummary, computeSaldoChain, getInvestmentsData, getLiquidityData } = useData();
  const { selectedPeriodId } = usePeriod();
  const userCanAdd = canAdd(user);

  const [selectedDate, setSelectedDate] = useState<string>(todayISO());
  const [snapshots, setSnapshots] = useState<ChannelBalance[]>([]);
  const [loadingSnap, setLoadingSnap] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({}); // pending edits per channel key
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [pinnedWallets, setPinnedWallets] = useState<PinnedCoinsbuyWallet[]>([]);
  const [showCoinsbuyModal, setShowCoinsbuyModal] = useState(false);
  const isAdmin = user?.role === 'admin';
  // Access-control result is computed here but the early return happens at
  // the bottom of the component — pulling it up before the rest of the
  // hooks would violate the Rules of Hooks on re-renders where access
  // changes (e.g. role switch in the same session).
  const accessDenied = !hasModuleAccess(user, 'balances');

  // ─── Section A: Balance Actual Disponible (chained across periods) ───
  // Formula per period: Net Deposit - Egresos Operativos - Monto a Distribuir
  // The result accumulates as the starting balance of the next period.
  //
  // For derived-broker periods (April 2026+), Net Deposit also includes the
  // API transactions persisted in api_transactions — otherwise the current
  // month would read as $0 until someone manually loads deposits in /upload.

  const [apiMonthly, setApiMonthly] = useState<Record<string, { deposits: number; withdrawals: number }>>({});
  const [apiTotalsLoading, setApiTotalsLoading] = useState(false);

  const loadApiMonthly = useCallback(async () => {
    setApiTotalsLoading(true);
    try {
      // Pull the last 18 months of persisted API data — enough for the 6-month
      // window plus history for the accumulation chain.
      const end = new Date();
      const start = new Date(end.getFullYear(), end.getMonth() - 17, 1);
      const pad = (n: number) => String(n).padStart(2, '0');
      const from = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-01`;
      const to = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate())}`;
      const res = await fetch(`/api/integrations/period-totals?from=${from}&to=${to}`);
      const json = await res.json();
      if (json.success) setApiMonthly(json.months ?? {});
    } catch {
      // Non-fatal — card will fall back to 0 API contribution.
    } finally {
      setApiTotalsLoading(false);
    }
  }, []);

  // Load once on mount.
  useEffect(() => {
    loadApiMonthly();
  }, [loadApiMonthly]);

  const balanceChain = useMemo(() => {
    const saldoChain = computeSaldoChain();
    let acumulado = 0;
    const rows: Array<{
      periodId: string;
      label: string;
      netDeposit: number;
      egresos: number;
      montoDistribuir: number;
      balanceMes: number;
      saldoInicial: number;
      saldoFinal: number;
    }> = [];

    for (const p of periods) {
      const summary = getPeriodSummary(p.id);
      if (!summary) continue;
      const saldoInfo = saldoChain.get(p.id);
      const montoDistribuir = saldoInfo?.totalDistribuir ?? 0;

      // Base net deposit from manual entries in /upload.
      let netDeposit = summary.netDeposit;

      // For derived-broker periods, add the API-persisted net (deposits − withdrawals)
      // for that calendar month, so the hero shows a real number on day 1
      // without waiting for someone to load /upload. The value matches the
      // coexistence rule used in /movimientos: API + manual.
      if (isDerivedBrokerPeriod({ year: p.year, month: p.month })) {
        const ymKey = `${p.year}-${String(p.month).padStart(2, '0')}`;
        const api = apiMonthly[ymKey];
        if (api) {
          netDeposit += api.deposits - api.withdrawals;
        }
      }

      const egresos = summary.totalExpenses;
      const balanceMes = netDeposit - egresos - montoDistribuir;
      const saldoInicial = acumulado;
      acumulado = saldoInicial + balanceMes;
      rows.push({
        periodId: p.id,
        label: p.label || `${p.year}-${String(p.month).padStart(2, '0')}`,
        netDeposit,
        egresos,
        montoDistribuir,
        balanceMes,
        saldoInicial,
        saldoFinal: acumulado,
      });
    }
    return rows;
  }, [periods, getPeriodSummary, computeSaldoChain, apiMonthly]);

  // The month shown in "Balance Actual Disponible". Starts tracking the
  // globally selected period, but the user can override it from the in-card
  // selector — this decouples "which balances-by-channel day am I viewing"
  // from "which month am I viewing in the accumulated balance card".
  const [balanceMonthPeriodId, setBalanceMonthPeriodId] = useState<string>('');
  useEffect(() => {
    // Initialize (or keep in sync when globally selected period changes and
    // the user hasn't overridden yet).
    if (!balanceMonthPeriodId && selectedPeriodId) {
      setBalanceMonthPeriodId(selectedPeriodId);
    }
  }, [selectedPeriodId, balanceMonthPeriodId]);

  const selectedIndex = useMemo(() => {
    const targetId = balanceMonthPeriodId || selectedPeriodId;
    const idx = balanceChain.findIndex(r => r.periodId === targetId);
    return idx >= 0 ? idx : balanceChain.length - 1;
  }, [balanceChain, balanceMonthPeriodId, selectedPeriodId]);

  const sixMonthWindow = useMemo(() => {
    if (selectedIndex < 0) return [];
    const from = Math.max(0, selectedIndex - 5);
    return balanceChain.slice(from, selectedIndex + 1);
  }, [balanceChain, selectedIndex]);

  const currentBalanceRow = balanceChain[selectedIndex];

  // ─── Section B: Balances por Canal (snapshots for selected date) ───

  // Auto-derived values from other modules. Computed on-the-fly because the
  // stored `balance` column on liquidity_movements / investments is always
  // 0 (insert bug — addLiquidityRow / addInvestmentRow never called
  // recalc*Balances). Running sum is the correct current balance regardless.
  const liquidityBalance = useMemo(() => {
    const data = getLiquidityData();
    return data.reduce((s, m) => s + m.deposit - m.withdrawal, 0);
  }, [getLiquidityData]);

  const investmentsBalance = useMemo(() => {
    const data = getInvestmentsData();
    return data.reduce((s, i) => s + i.deposit - i.withdrawal + i.profit, 0);
  }, [getInvestmentsData]);

  // ─── Coinsbuy Wallets (API en tiempo real) — declared early for getChannelValue ───
  interface WalletData {
    id: string;
    label: string;
    balanceConfirmed: number;
    balancePending: number;
    currencyCode: string;
    currencyName: string;
  }

  const [wallets, setWallets] = useState<WalletData[]>([]);
  const [walletsLoading, setWalletsLoading] = useState(false);
  const [walletsError, setWalletsError] = useState<string | null>(null);
  const [walletsFetchedAt, setWalletsFetchedAt] = useState<string | null>(null);
  const [walletsIsMock, setWalletsIsMock] = useState(false);
  const [walletToggles, setWalletToggles] = useState<Record<string, boolean>>({});

  const fetchWallets = useCallback(async () => {
    setWalletsLoading(true);
    setWalletsError(null);
    try {
      const res = await fetch('/api/integrations/coinsbuy/wallets');
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Error fetching wallets');
      setWallets(json.wallets ?? []);
      setWalletsFetchedAt(json.fetchedAt ?? new Date().toISOString());
      setWalletsIsMock(json.isMock ?? false);
      // Initialize toggles for new wallets (default: on)
      setWalletToggles(prev => {
        const next = { ...prev };
        for (const w of json.wallets ?? []) {
          if (next[w.id] === undefined) next[w.id] = true;
        }
        return next;
      });
    } catch (err) {
      setWalletsError(err instanceof Error ? err.message : 'Error');
    } finally {
      setWalletsLoading(false);
    }
  }, []);

  // Fetch on mount + auto-refresh every 5 minutes. The interval pauses
  // while the tab is hidden so we don't burn API quota on a backgrounded
  // page; when the tab becomes visible again we refresh immediately.
  useEffect(() => {
    fetchWallets();
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval) return;
      interval = setInterval(fetchWallets, 5 * 60 * 1000);
    };
    const stop = () => {
      if (interval) { clearInterval(interval); interval = null; }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        fetchWallets();
        start();
      } else {
        stop();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchWallets]);

  const toggleWallet = (id: string) => {
    setWalletToggles(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const walletTotal = wallets
    .filter(w => walletToggles[w.id] !== false)
    .reduce((sum, w) => sum + w.balanceConfirmed, 0);

  // Load pinned wallets from Supabase
  const loadPinnedWallets = useCallback(async () => {
    if (!company) return;
    const pins = await fetchPinnedCoinsbuyWallets(company.id);
    setPinnedWallets(pins);
  }, [company]);

  useEffect(() => {
    loadPinnedWallets();
  }, [loadPinnedWallets]);

  // Pin / unpin handlers (admin only)
  const handlePin = async (walletId: string, label: string) => {
    if (!company) return;
    try {
      await pinCoinsbuyWallet(company.id, walletId, label);
      setOkMsg('Wallet fijada en Balances');
      setTimeout(() => setOkMsg(null), 2000);
      await loadPinnedWallets();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Error fijando wallet');
    }
  };

  const handleUnpin = async (walletId: string) => {
    if (!company) return;
    try {
      await unpinCoinsbuyWallet(company.id, walletId);
      setOkMsg('Wallet removida de Balances');
      setTimeout(() => setOkMsg(null), 2000);
      await loadPinnedWallets();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Error removiendo wallet');
    }
  };

  const isPinned = (walletId: string) =>
    pinnedWallets.some(p => p.wallet_id === walletId);

  // Get balance of a pinned wallet from the API wallets data
  const getPinnedWalletBalance = (walletId: string): number => {
    const w = wallets.find(wl => wl.id === walletId);
    return w?.balanceConfirmed ?? 0;
  };

  // Total of all pinned wallet balances (for the consolidated total)
  const pinnedWalletsTotal = useMemo(() => {
    return pinnedWallets.reduce((sum, p) => sum + getPinnedWalletBalance(p.wallet_id), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedWallets, wallets]);

  // ─── UniPayment Balance (API en tiempo real) ───
  const [unipaymentBalance, setUnipaymentBalance] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const fetchUniBalance = async () => {
      try {
        const res = await fetch('/api/integrations/unipayment/balances');
        const json = await res.json();
        if (!cancelled && json.success && Array.isArray(json.balances) && json.balances.length > 0) {
          // Sum all available balances (primary wallet)
          const total = json.balances.reduce(
            (sum: number, b: { availableBalance: number }) => sum + (b.availableBalance ?? 0),
            0,
          );
          setUnipaymentBalance(total);
        }
      } catch {
        // Silent — channel shows $0 on error
      }
    };
    fetchUniBalance();
    let interval: ReturnType<typeof setInterval> | null = setInterval(fetchUniBalance, 5 * 60 * 1000);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        fetchUniBalance();
        if (!interval) interval = setInterval(fetchUniBalance, 5 * 60 * 1000);
      } else if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Load snapshots for selected date
  const loadSnapshots = async () => {
    if (!company) return;
    setLoadingSnap(true);
    setErrMsg(null);
    try {
      const data = await fetchChannelBalances(company.id, selectedDate);
      setSnapshots(data);
      setEditing({});
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Error cargando snapshots');
    } finally {
      setLoadingSnap(false);
    }
  };

  useEffect(() => {
    loadSnapshots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id, selectedDate]);

  // Helper: get value for a channel for the selected date.
  //
  // Resolution order per channel:
  //   1. Snapshot stored in channel_balances for the selected date
  //      (written by the daily cron at 00:00 UTC or by manual edits).
  //   2. Live API value (coinsbuy/unipayment) — only sensible when viewing
  //      TODAY, since live always represents "right now".
  //   3. Zero as last resort.
  //
  // For liquidez/inversiones, we can always reconstruct the balance from
  // the movements table on the fly, so we use that directly.
  const getChannelValue = (key: string): number => {
    if (key === 'liquidez') return liquidityBalance;
    if (key === 'inversiones') return investmentsBalance;

    const snap = snapshots.find((s) => s.channel_key === key);

    if (key === 'coinsbuy') {
      // Past date with snapshot → show historical value.
      if (snap && snap.source) return snap.amount;
      // Today / no snapshot → live API total.
      return pinnedWalletsTotal;
    }
    if (key === 'unipayment') {
      // Manual override always wins (user explicitly set a value).
      if (snap && snap.source === 'manual') return snap.amount;
      // API-captured snapshot for a past date → show that.
      if (snap && snap.source === 'api') return snap.amount;
      // Today / no snapshot → live API.
      if (unipaymentBalance > 0) return unipaymentBalance;
      return snap?.amount ?? 0;
    }
    return snap?.amount ?? 0;
  };

  const startEdit = (key: string) => {
    if (!userCanAdd) return;
    setEditing(prev => ({ ...prev, [key]: String(getChannelValue(key)) }));
  };

  const cancelEdit = (key: string) => {
    setEditing(prev => {
      const { [key]: _omit, ...rest } = prev;
      return rest;
    });
  };

  const saveEdit = async (key: string) => {
    if (!company) return;
    const raw = editing[key] ?? '';
    const value = parseFloat(raw) || 0;
    setSavingKey(key);
    setErrMsg(null);
    try {
      await upsertChannelBalance(company.id, selectedDate, key, value, 'manual');
      setOkMsg('Balance guardado');
      setTimeout(() => setOkMsg(null), 2000);
      cancelEdit(key);
      await loadSnapshots();
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Error guardando balance');
    } finally {
      setSavingKey(null);
    }
  };

  // Total consolidado (suma de todos los canales)
  const totalConsolidado = CHANNELS.reduce((sum, c) => sum + getChannelValue(c.key), 0);

  // ─── Section C: Coinsbuy Wallets (state + fetch declared above) ───

  if (accessDenied) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">{t('common.noAccess')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header — filters are in-card (see each Card below). */}
      <PageHeader
        title={t('balances.title')}
        subtitle={t('balances.subtitle')}
        icon={Wallet}
      />

      {okMsg && (
        <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 text-sm">
          {okMsg}
        </div>
      )}
      {errMsg && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
          {errMsg}
        </div>
      )}

      {/* ═══════════ SECTION A: RESUMEN DEL MES ═══════════ */}
      <Card>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/50">
              <Wallet className="w-5 h-5 text-blue-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Resumen del mes</h2>
              <p className="text-xs text-muted-foreground">
                Net Deposit − Egresos Operativos − Monto a Distribuir. Se acumula al siguiente período.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Month selector — in-card. Replaces the top-right date picker.
                Each option label includes how that month closed so the user
                sees historical values at a glance. */}
            {balanceChain.length > 0 && (
              <select
                value={balanceMonthPeriodId || selectedPeriodId || ''}
                onChange={(e) => setBalanceMonthPeriodId(e.target.value)}
                className="h-9 px-3 text-sm rounded-lg border border-border bg-card min-w-[200px] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
                aria-label="Seleccionar mes"
              >
                {balanceChain.map((r) => (
                  <option key={r.periodId} value={r.periodId}>
                    {r.label} — {formatCurrency(r.saldoFinal)}
                  </option>
                ))}
              </select>
            )}
            {/* Refrescar API totals — re-reads api_transactions so Abr 26
                (or whatever the current month is) picks up fresh data. */}
            <button
              onClick={loadApiMonthly}
              disabled={apiTotalsLoading}
              className="p-2 rounded-lg border border-border bg-card hover:bg-muted transition-colors disabled:opacity-50"
              title="Refrescar datos de API"
              aria-label="Refrescar datos de API"
            >
              <RefreshCw className={`w-4 h-4 ${apiTotalsLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {currentBalanceRow ? (
          <>
            <div className="text-center py-6 mb-4 bg-muted/30 rounded-lg">
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
                Resultado del mes · {currentBalanceRow.label}
              </p>
              <p className={`text-3xl sm:text-4xl font-bold tabular-nums ${currentBalanceRow.balanceMes >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {formatCurrency(currentBalanceRow.balanceMes)}
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Net Deposit − Egresos − Monto a Distribuir (acumulado del mes: <span className="font-medium text-foreground">{formatCurrency(currentBalanceRow.saldoFinal)}</span>)
              </p>
            </div>

            {/* Breakdown of where each number comes from */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <div className="p-3 rounded-lg border border-border">
                <p className="text-xs text-muted-foreground">{t('balances.netDeposit')}</p>
                <p className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">
                  +{formatCurrency(currentBalanceRow.netDeposit)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{t('balances.fromMovements')}</p>
              </div>
              <div className="p-3 rounded-lg border border-border">
                <p className="text-xs text-muted-foreground">{t('balances.operatingExpenses')}</p>
                <p className="text-lg font-semibold text-red-600 dark:text-red-400">
                  −{formatCurrency(currentBalanceRow.egresos)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{t('balances.fromExpenses')}</p>
              </div>
              <div className="p-3 rounded-lg border border-border">
                <p className="text-xs text-muted-foreground">{t('balances.amountToDistribute')}</p>
                <p className="text-lg font-semibold text-orange-600 dark:text-orange-400">
                  −{formatCurrency(currentBalanceRow.montoDistribuir)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{t('balances.fromPartners')}</p>
              </div>
              <div className="p-3 rounded-lg border border-border bg-blue-50/50 dark:bg-blue-950/20">
                <p className="text-xs text-muted-foreground">{t('balances.previousMonthBalance')}</p>
                <p className="text-lg font-semibold">
                  {formatCurrency(currentBalanceRow.saldoInicial)}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{t('balances.carryOver')}</p>
              </div>
            </div>

            {/* History of all months */}
            <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('balances.period')}</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('balances.netDeposit')}</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('balances.operatingExpenses')}</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('balances.amountToDistribute')}</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('balances.balanceMonth')}</th>
                    <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('balances.accumulated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sixMonthWindow.map((row) => {
                    const isSelected = row.periodId === currentBalanceRow?.periodId;
                    return (
                      <tr
                        key={row.periodId}
                        className={`border-b border-border/50 ${isSelected ? 'bg-blue-50/40 dark:bg-blue-950/20 font-medium' : 'hover:bg-muted/30'}`}
                      >
                        <td className="py-2 px-3 font-medium">{row.label}</td>
                        <td className="py-2 px-3 text-right text-emerald-600 dark:text-emerald-400">{formatCurrency(row.netDeposit)}</td>
                        <td className="py-2 px-3 text-right text-red-600 dark:text-red-400">{formatCurrency(row.egresos)}</td>
                        <td className="py-2 px-3 text-right text-orange-600 dark:text-orange-400">{formatCurrency(row.montoDistribuir)}</td>
                        <td className={`py-2 px-3 text-right font-medium ${row.balanceMes >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatCurrency(row.balanceMes)}</td>
                        <td className={`py-2 px-3 text-right font-bold ${row.saldoFinal >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatCurrency(row.saldoFinal)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-center text-muted-foreground py-8">{t('balances.noData')}</p>
        )}
      </Card>

      {/* ═══════════ SECTION B: BALANCES POR CANAL ═══════════ */}
      <Card>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-violet-50 dark:bg-violet-950/50">
              <Plug className="w-5 h-5 text-violet-500" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">{t('balances.byChannel')}</h2>
              <p className="text-xs text-muted-foreground">
                {t('balances.byChannelHint')}
              </p>
            </div>
          </div>
          {/* Day filter — in-card. Picks a specific day to view the snapshot
              of how every channel closed. Cron writes daily snapshots at
              00:00 UTC so historical days are queryable. */}
          <div className="flex items-center gap-2">
            <Calendar className="w-4 h-4 text-muted-foreground" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="h-9 px-3 text-sm rounded-lg border border-border bg-card focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30"
              aria-label="Fecha del snapshot"
            />
            <button
              onClick={loadSnapshots}
              disabled={loadingSnap}
              className="p-2 rounded-lg border border-border bg-card hover:bg-muted transition-colors disabled:opacity-50"
              title="Recargar"
              aria-label="Recargar"
            >
              <RefreshCw className={`w-4 h-4 ${loadingSnap ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {CHANNELS.map((ch) => {
            const value = getChannelValue(ch.key);
            const isEditing = editing[ch.key] !== undefined;
            const isAuto = ch.type === 'auto';
            const isCoinsbuy = ch.key === 'coinsbuy';
            // Channels where the user can overwrite the auto-fetched value.
            const canOverride = !!ch.allowManualOverride;
            const Icon = ch.icon;

            return (
              <div key={ch.key}>
              <div
                className="flex items-center justify-between gap-3 p-3 rounded-lg border border-border hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  {Icon && <Icon className="w-4 h-4 text-muted-foreground shrink-0" />}
                  <div className="min-w-0">
                    <p className="font-medium truncate">{ch.label}</p>
                    <p className="text-xs text-muted-foreground truncate">{ch.description}</p>
                  </div>
                  {isAuto && !canOverride && (
                    <span className="hidden sm:inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                      Automático
                    </span>
                  )}
                  {canOverride && (
                    <span className="hidden sm:inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                      API + manual
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {isEditing ? (
                    <>
                      <input
                        type="number"
                        step="0.01"
                        value={editing[ch.key]}
                        onChange={(e) => setEditing(prev => ({ ...prev, [ch.key]: e.target.value }))}
                        className="w-32 px-2 py-1 rounded border border-border text-sm text-right"
                        autoFocus
                      />
                      <button
                        onClick={() => saveEdit(ch.key)}
                        disabled={savingKey === ch.key}
                        className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 rounded disabled:opacity-50"
                        aria-label="Guardar"
                      >
                        {savingKey === ch.key ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => cancelEdit(ch.key)}
                        className="p-1 text-muted-foreground hover:bg-muted rounded"
                        aria-label="Cancelar"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className={`font-semibold text-base ${value >= 0 ? '' : 'text-red-600 dark:text-red-400'}`}>
                        {formatCurrency(value)}
                      </span>
                      {((!isAuto && !isCoinsbuy) || canOverride) && userCanAdd && (
                        <button
                          onClick={() => startEdit(ch.key)}
                          className="p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded"
                          aria-label="Editar"
                          title={canOverride ? 'Agregar valor manual (respaldo si la API falla)' : 'Editar balance'}
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {isCoinsbuy && isAdmin && (
                        <button
                          onClick={() => setShowCoinsbuyModal(true)}
                          className="p-1 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded"
                          aria-label="Editar wallets"
                          title="Elegir wallets de Coinsbuy"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Pinned wallet sub-rows under Coinsbuy */}
              {isCoinsbuy && pinnedWallets.length > 0 && (
                <div className="ml-6 mt-1 space-y-1">
                  {pinnedWallets.map((pw) => {
                    const wBalance = getPinnedWalletBalance(pw.wallet_id);
                    const wData = wallets.find(wl => wl.id === pw.wallet_id);
                    return (
                      <div
                        key={pw.wallet_id}
                        className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border/50 bg-emerald-50/30 dark:bg-emerald-950/10"
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          <Wallet className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{pw.wallet_label}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {wData?.currencyCode ?? 'USDT'} · Wallet #{pw.wallet_id}
                            </p>
                          </div>
                        </div>
                        <span className="font-semibold text-sm tabular-nums">
                          {formatCurrency(wBalance)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              </div>
            );
          })}
        </div>

        {/* Total consolidado */}
        <div className="mt-4 pt-4 border-t border-border flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {t('balances.totalConsolidated')}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('balances.totalHint')}
            </p>
          </div>
          <p className={`text-2xl font-bold ${totalConsolidado >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {formatCurrency(totalConsolidado)}
          </p>
        </div>
      </Card>

      {/* Modal: Coinsbuy wallet selector (admin only, triggered from the
          pencil button on the Coinsbuy row above). Lets admin pick which
          wallets get summed into the Balances por Canal total. */}
      {isAdmin && showCoinsbuyModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowCoinsbuyModal(false)}
        >
          <div
            className="bg-card border border-border rounded-xl shadow-lg w-full max-w-2xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-border">
              <div className="flex items-center gap-3 min-w-0">
                <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 shrink-0">
                  <Wallet className="w-5 h-5 text-emerald-500" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold">Wallets de Coinsbuy</h2>
                  <p className="text-xs text-muted-foreground">
                    Elige cuáles suman al balance del canal
                    {walletsIsMock && <span className="ml-1 text-amber-500">(Mock)</span>}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {walletsFetchedAt && (
                  <span className="text-[10px] text-muted-foreground hidden sm:inline">
                    Sync: {new Date(walletsFetchedAt).toLocaleTimeString('es-ES')}
                  </span>
                )}
                <button
                  onClick={fetchWallets}
                  disabled={walletsLoading}
                  className="p-2 rounded-lg border border-border bg-card hover:bg-muted transition-colors disabled:opacity-50"
                  title="Refrescar wallets"
                >
                  <RefreshCw className={`w-4 h-4 ${walletsLoading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  onClick={() => setShowCoinsbuyModal(false)}
                  className="p-2 rounded-lg hover:bg-muted"
                  aria-label="Cerrar"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="p-5 overflow-y-auto flex-1">
              {walletsError && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300 text-sm mb-3">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    {walletsError}
                    {walletsFetchedAt && ` — Datos desactualizados (última sync: ${new Date(walletsFetchedAt).toLocaleString('es-ES')})`}
                  </span>
                </div>
              )}

              <p className="text-xs text-muted-foreground mb-3">
                Usa el <strong>pin</strong> para incluir/excluir una wallet del canal Coinsbuy en Balances por Canal. El toggle controla si se suma al total temporal de esta vista.
              </p>

              {wallets.length > 0 ? (
                <div className="space-y-2">
                  {wallets.map((w) => {
                    const isOn = walletToggles[w.id] !== false;
                    return (
                      <div
                        key={w.id}
                        className={`flex items-center justify-between gap-3 p-3 rounded-lg border transition-colors ${
                          isOn ? 'border-border hover:bg-muted/30' : 'border-border/50 bg-muted/20 opacity-60'
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <button
                            onClick={() => toggleWallet(w.id)}
                            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                            title={isOn ? 'Excluir del total' : 'Incluir en el total'}
                          >
                            {isOn
                              ? <ToggleRight className="w-6 h-6 text-emerald-500" />
                              : <ToggleLeft className="w-6 h-6" />
                            }
                          </button>
                          <div className="min-w-0">
                            <p className="font-medium truncate">{w.label}</p>
                            <p className="text-xs text-muted-foreground">
                              {w.currencyCode}
                              {w.balancePending > 0 && (
                                <span className="ml-2 text-amber-500">
                                  Pendiente: {w.balancePending.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`font-semibold text-sm tabular-nums ${isOn ? '' : 'text-muted-foreground'}`}>
                            {w.balanceConfirmed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 })} {w.currencyCode}
                          </span>
                          {isPinned(w.id) ? (
                            <button
                              onClick={() => handleUnpin(w.id)}
                              className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 rounded"
                              title="Quitar de Balances por Canal"
                            >
                              <PinOff className="w-4 h-4" />
                            </button>
                          ) : (
                            <button
                              onClick={() => handlePin(w.id, w.label)}
                              className="p-1 text-muted-foreground hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded"
                              title="Fijar en Balances por Canal"
                            >
                              <Pin className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : walletsLoading ? (
                <p className="text-center text-muted-foreground py-8">Cargando wallets…</p>
              ) : (
                <p className="text-center text-muted-foreground py-8">No hay wallets activas</p>
              )}
            </div>

            {/* Footer totals */}
            {wallets.length > 0 && (
              <div className="p-4 border-t border-border flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Wallets fijadas
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {pinnedWallets.length} fijada{pinnedWallets.length === 1 ? '' : 's'} · suman en Balances por Canal
                  </p>
                </div>
                <button
                  onClick={() => setShowCoinsbuyModal(false)}
                  className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
                >
                  Listo
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
