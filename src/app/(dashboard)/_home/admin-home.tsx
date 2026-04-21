'use client';

import { useMemo } from 'react';
import { StatCard } from '@/components/ui/stat-card';
import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { QuickAccess } from './quick-access';
import {
  ArrowDownCircle, ArrowUpCircle, Wallet, Receipt, TrendingUp,
  TrendingDown, Briefcase, Droplets, Loader2,
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

  // ── Variations vs prior period ────────────────────────────────────────
  const pct = (now: number, prev: number) => {
    if (!prev) return null;
    return ((now - prev) / Math.abs(prev)) * 100;
  };

  const netDepositDelta = currentSummary && prevSummary
    ? pct(currentSummary.netDeposit, prevSummary.netDeposit)
    : null;
  const expensesDelta = currentSummary && prevSummary
    ? pct(currentSummary.totalExpenses, prevSummary.totalExpenses)
    : null;
  const withdrawalsDelta = currentSummary && prevSummary
    ? pct(currentSummary.totalWithdrawals, prevSummary.totalWithdrawals)
    : null;

  // ── Available balance = ingresos netos − gastos pagados ───────────────
  // Simplified from /balances: show the running figure for the current period.
  const balanceDisponible = useMemo(() => {
    if (!currentSummary) return 0;
    const ingresosNetos = (currentSummary.operatingIncome
      ? currentSummary.operatingIncome.broker_pnl + currentSummary.operatingIncome.other
      : 0) + currentSummary.propFirmNetIncome;
    return ingresosNetos - currentSummary.totalExpenses;
  }, [currentSummary]);

  const prevBalance = useMemo(() => {
    if (!prevSummary) return 0;
    const ingresosNetos = (prevSummary.operatingIncome
      ? prevSummary.operatingIncome.broker_pnl + prevSummary.operatingIncome.other
      : 0) + prevSummary.propFirmNetIncome;
    return ingresosNetos - prevSummary.totalExpenses;
  }, [prevSummary]);

  const balanceDelta = pct(balanceDisponible, prevBalance);

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

      {/* Row 1 — Flow of the month */}
      {loading && !currentSummary ? (
        <SkeletonRow n={4} />
      ) : hasFinance ? (
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            label="Net Deposit · mes"
            value={formatCurrency(currentSummary?.netDeposit ?? 0)}
            icon={Wallet}
            tone={(currentSummary?.netDeposit ?? 0) >= 0 ? 'positive' : 'negative'}
            hint={deltaHint(netDepositDelta)}
          />
          <StatCard
            label="Depósitos · mes"
            value={formatCurrency(currentSummary?.totalDeposits ?? 0)}
            icon={ArrowDownCircle}
            tone="info"
          />
          <StatCard
            label="Egresos · mes"
            value={formatCurrency(currentSummary?.totalExpenses ?? 0)}
            icon={Receipt}
            tone="warning"
            hint={deltaHint(expensesDelta, /* invertColor */ true)}
          />
          <StatCard
            label="Retiros · mes"
            value={formatCurrency(currentSummary?.totalWithdrawals ?? 0)}
            icon={ArrowUpCircle}
            tone="warning"
            hint={deltaHint(withdrawalsDelta, /* invertColor */ true)}
          />
        </section>
      ) : null}

      {/* Row 2 — Position snapshot */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {hasFinance && (
          <StatCard
            label="Balance Disponible"
            value={formatCurrency(balanceDisponible)}
            icon={TrendingUp}
            tone={balanceDisponible >= 0 ? 'positive' : 'negative'}
            hint={deltaHint(balanceDelta)}
          />
        )}
        {has('partners') && (
          <StatCard
            label="Socios"
            value={partners.length.toString()}
            icon={Briefcase}
            tone="primary"
          />
        )}
        {has('investments') && (
          <ModuleMoneyCard label="Inversiones · balance" kind="investments" />
        )}
        {has('liquidity') && (
          <ModuleMoneyCard label="Liquidez · balance" kind="liquidity" />
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
