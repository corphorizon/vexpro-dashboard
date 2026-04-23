'use client';

import { useEffect, useMemo, useState } from 'react';
import { StatCard } from '@/components/ui/stat-card';
import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useApiCoexistence } from '@/lib/use-api-coexistence';
import { formatCurrency } from '@/lib/utils';
import { withActiveCompany } from '@/lib/api-fetch';
import { QuickAccess } from './quick-access';
import {
  ArrowDownCircle, ArrowUpCircle, Wallet, Receipt, TrendingUp,
  TrendingDown, Briefcase, Droplets, Layers, Loader2,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// AdminHome — full dashboard for company admins (and superadmin when
// entering a company via /superadmin/viewing/[id]).
//
// Two rows of stat cards + quick access:
//   Row 1 (financial flow): Net Deposit · Depósitos · Egresos · Retiros
//   Row 2 (position):       Balance Disponible · Socios · Inversiones · Liquidez
//
// Row 1 is gated by the 'movements' module; Row 2 cards individually gated
// by their respective module flags.
// ─────────────────────────────────────────────────────────────────────────────

export function AdminHome() {
  const { user } = useAuth();
  const {
    company,
    periods,
    getPeriodSummary,
    partners,
    loading,
  } = useData();

  // ── Current period resolution ─────────────────────────────────────────
  // The UI period selector lives elsewhere; here we pick the most recent
  // non-closed period (or the newest one).
  const currentPeriod = useMemo(() => {
    if (!periods.length) return null;
    const open = [...periods]
      .reverse()
      .find((p) => !p.is_closed);
    return open ?? periods[periods.length - 1];
  }, [periods]);

  const prevPeriod = useMemo(() => {
    if (!currentPeriod) return null;
    const idx = periods.findIndex((p) => p.id === currentPeriod.id);
    return idx > 0 ? periods[idx - 1] : null;
  }, [periods, currentPeriod]);

  const currentSummary = currentPeriod ? getPeriodSummary(currentPeriod.id) : null;
  const prevSummary = prevPeriod ? getPeriodSummary(prevPeriod.id) : null;

  // ── API + manual consolidation ────────────────────────────────────────
  // Mirrors /resumen-general and /movimientos so the home matches what
  // the user sees on those pages. Without this, post Apr-2026 periods
  // showed only the manual subset (often $0) and looked broken.
  const currentCoexist = useApiCoexistence(currentPeriod ? [currentPeriod] : []);
  const prevCoexist = useApiCoexistence(prevPeriod ? [prevPeriod] : []);

  const consolidate = (
    summary: typeof currentSummary,
    coexist: typeof currentCoexist,
  ) => {
    if (!summary) return { deposits: 0, withdrawals: 0, netDeposit: 0, balance: 0 };
    const useDerivedBroker = coexist.useDerivedBroker;

    const manualCoinsbuy = summary.deposits.find((d) => d.channel === 'coinsbuy')?.amount ?? 0;
    const manualFairpay = summary.deposits.find((d) => d.channel === 'fairpay')?.amount ?? 0;
    const manualUnipayment = summary.deposits.find((d) => d.channel === 'unipayment')?.amount ?? 0;
    const storedOther = summary.deposits.find((d) => d.channel === 'other')?.amount ?? 0;
    const deposits = useDerivedBroker
      ? coexist.apiDepositsTotal(manualCoinsbuy, manualFairpay, manualUnipayment) + storedOther
      : summary.totalDeposits;

    const ibCommissions = summary.withdrawals.find((w) => w.category === 'ib_commissions')?.amount ?? 0;
    const propFirmW = summary.withdrawals.find((w) => w.category === 'prop_firm')?.amount ?? 0;
    const otherW = summary.withdrawals.find((w) => w.category === 'other')?.amount ?? 0;
    const storedBroker = summary.withdrawals.find((w) => w.category === 'broker')?.amount ?? 0;
    const derivedBrokerFromApi = coexist.derivedBrokerFromApi(ibCommissions, propFirmW, otherW);
    const brokerConsolidated = useDerivedBroker ? derivedBrokerFromApi + storedBroker : storedBroker;
    const withdrawals = useDerivedBroker
      ? brokerConsolidated + ibCommissions + propFirmW + otherW
      : summary.totalWithdrawals;

    const netDeposit = deposits - withdrawals;

    const ingresosNetos = (summary.operatingIncome
      ? summary.operatingIncome.broker_pnl + summary.operatingIncome.other
      : 0) + summary.propFirmNetIncome;
    const balance = ingresosNetos - summary.totalExpenses;

    return { deposits, withdrawals, netDeposit, balance };
  };

  const cur = useMemo(() => consolidate(currentSummary, currentCoexist), [currentSummary, currentCoexist]);
  const prv = useMemo(() => consolidate(prevSummary, prevCoexist), [prevSummary, prevCoexist]);

  const pct = (now: number, prev: number) => {
    if (!prev) return null;
    return ((now - prev) / Math.abs(prev)) * 100;
  };

  const netDepositDelta = pct(cur.netDeposit, prv.netDeposit);
  const expensesDelta = currentSummary && prevSummary
    ? pct(currentSummary.totalExpenses, prevSummary.totalExpenses)
    : null;
  const withdrawalsDelta = pct(cur.withdrawals, prv.withdrawals);

  // ── Total Consolidado (suma de todos los canales) ─────────────────────
  // Pulls from /api/balances/total-consolidado, which calls Coinsbuy +
  // UniPayment APIs LIVE, reads channel_balances_as_of(today) for the
  // manual channels, and adds liquidity + investments running sums. So
  // the number matches the bottom of /balances even before the daily cron
  // has captured today's snapshot.
  // Auto-refresh every 5 min while the tab is visible.
  const [totalConsolidado, setTotalConsolidado] = useState<number | null>(null);

  useEffect(() => {
    if (!company?.id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(withActiveCompany('/api/balances/total-consolidado'));
        const json = await res.json();
        if (!cancelled && json.success) setTotalConsolidado(Number(json.total));
      } catch {
        if (!cancelled) setTotalConsolidado(0);
      }
    };
    load();
    let interval: ReturnType<typeof setInterval> | null = setInterval(load, 5 * 60 * 1000);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        load();
        if (!interval) interval = setInterval(load, 5 * 60 * 1000);
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
  }, [company?.id]);

  // ── Module availability shortcuts ──────────────────────────────────────
  const has = (m: string) => hasModuleAccess(user, m, company?.active_modules);
  const hasFinance = has('movements');

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Hola, {user?.name?.split(' ')[0] ?? ''}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {company?.name
            ? `Panel de ${company.name}${currentPeriod ? ` · ${currentPeriod.label}` : ''}`
            : 'Panel'}
        </p>
      </header>

      {/* Row 1 — Flow of the month
            Order: Net Deposit · Depósitos · Retiros · Egresos
            (depositos and retiros sit together so net deposit "story" reads
             left-to-right). All values consolidate API + manual. */}
      {loading && !currentSummary ? (
        <SkeletonRow n={4} />
      ) : hasFinance ? (
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Net Deposit · mes"
            value={formatCurrency(cur.netDeposit)}
            icon={Wallet}
            tone={cur.netDeposit >= 0 ? 'positive' : 'negative'}
            hint={deltaHint(netDepositDelta)}
          />
          <StatCard
            label="Depósitos · mes"
            value={formatCurrency(cur.deposits)}
            icon={ArrowDownCircle}
            tone="info"
          />
          <StatCard
            label="Retiros · mes"
            value={formatCurrency(cur.withdrawals)}
            icon={ArrowUpCircle}
            tone="warning"
            hint={deltaHint(withdrawalsDelta, /* invertColor */ true)}
          />
          <StatCard
            label="Egresos · mes"
            value={formatCurrency(currentSummary?.totalExpenses ?? 0)}
            icon={Receipt}
            tone="warning"
            hint={deltaHint(expensesDelta, /* invertColor */ true)}
          />
        </section>
      ) : null}

      {/* Row 2 — Position snapshot
            Order: Total Consolidado · Inversiones · Liquidez · Socios
            (money figures grouped left, headcount card last) */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {hasFinance && (
          <StatCard
            label="Total Consolidado"
            value={totalConsolidado === null ? '—' : formatCurrency(totalConsolidado)}
            icon={Layers}
            tone={(totalConsolidado ?? 0) >= 0 ? 'positive' : 'negative'}
            hint="Suma de todos los balances"
          />
        )}
        {has('investments') && (
          <ModuleMoneyCard label="Inversiones · balance" kind="investments" />
        )}
        {has('liquidity') && (
          <ModuleMoneyCard label="Liquidez · balance" kind="liquidity" />
        )}
        {has('partners') && (
          <StatCard
            label="Socios"
            value={partners.length.toString()}
            icon={Briefcase}
            tone="primary"
          />
        )}
      </section>

      <QuickAccess />
    </div>
  );
}

function deltaHint(pct: number | null, invertColor = false): React.ReactNode {
  if (pct === null || !isFinite(pct)) return 'vs mes anterior: sin datos';
  const rounded = Math.round(pct * 10) / 10;
  const Arrow = rounded >= 0 ? TrendingUp : TrendingDown;
  const isPositive = invertColor ? rounded < 0 : rounded >= 0;
  const cls = isPositive ? 'text-emerald-600' : 'text-red-600';
  return (
    <span className={`inline-flex items-center gap-1 ${cls}`}>
      <Arrow className="w-3 h-3" />
      {rounded > 0 ? '+' : ''}{rounded}% vs mes anterior
    </span>
  );
}

function ModuleMoneyCard({ label, kind }: { label: string; kind: 'investments' | 'liquidity' }) {
  const { getLiquidityData, getInvestmentsData } = useData();
  const items = kind === 'investments' ? getInvestmentsData() : getLiquidityData();
  const running = useMemo(() => {
    const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
    let bal = 0;
    for (const m of sorted) {
      const delta = (m.deposit ?? 0) - (m.withdrawal ?? 0) + (('profit' in m) ? (m as { profit: number }).profit ?? 0 : 0);
      bal += delta;
    }
    return bal;
  }, [items]);
  return (
    <StatCard
      label={label}
      value={formatCurrency(running)}
      icon={kind === 'investments' ? TrendingUp : Droplets}
      tone={running >= 0 ? 'positive' : 'negative'}
      hint={items.length ? `${items.length} mov.` : 'Sin movimientos'}
    />
  );
}

function SkeletonRow({ n, height = 'h-28' }: { n: number; height?: string }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-pulse">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className={`${height} rounded-xl bg-muted/60`} />
      ))}
    </div>
  );
}

// Small export to make the Loader2 usage explicit (keeps import tree obvious).
export const _AdminLoader = Loader2;
