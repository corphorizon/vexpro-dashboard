'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { getAuditLog } from '@/lib/audit-log';
import { QuickAccess } from './quick-access';
import {
  ArrowDownCircle, ArrowUpCircle, Wallet, Receipt, TrendingUp,
  TrendingDown, Plug, Users, Briefcase, Droplets, Activity, Loader2,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// AdminHome — full dashboard for company admins (and superadmin when
// entering a company via /superadmin/viewing/[id]).
//
// Rows the spec defines:
//   1. Financial summary       (if module 'movements' active)
//   2. API status              (live fetch; only providers the tenant configured)
//   3. Module summary cards    (HR, partners, investments, liquidity — if active)
//   4. Recent activity         (last 5 audit entries)
//   5. Quick access            (all modules the user+company have enabled)
//
// All sections guarded by `hasModuleAccess` + `company.active_modules`, so an
// admin of a tenant that disabled a module never sees its row. When there's
// no data for the current period we show $0.00 / "Sin datos" cleanly.
// ─────────────────────────────────────────────────────────────────────────────

interface ApiCredRow {
  provider: string;
  is_configured: boolean;
  updated_at: string;
}

export function AdminHome() {
  const { user } = useAuth();
  const {
    company,
    periods,
    getPeriodSummary,
    employees,
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

  // ── Available balance = netDeposit − expensesPaid − partnerDistribution ─
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

  // ── APIs status ────────────────────────────────────────────────────────
  const [apis, setApis] = useState<ApiCredRow[] | null>(null);
  useEffect(() => {
    // Only admins of the tenant can read api_credentials. Fails silently for
    // lower roles (their hasModuleAccess gates already hid this UI anyway).
    fetch('/api/admin/api-credentials')
      .then((r) => r.json())
      .then((j) => { if (j.success) setApis(j.credentials); })
      .catch(() => setApis([]));
  }, []);

  // ── Recent activity ────────────────────────────────────────────────────
  const activity = useMemo(() => getAuditLog().slice(0, 5), []);

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
            label="Balance Disponible"
            value={formatCurrency(balanceDisponible)}
            icon={TrendingUp}
            tone={balanceDisponible >= 0 ? 'positive' : 'negative'}
            hint={deltaHint(balanceDelta)}
          />
        </section>
      ) : null}

      {/* APIs status */}
      <ApiStatusSection data={apis} />

      {/* Module summary cards */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {has('hr') && (
          <StatCard
            label="Empleados"
            value={employees.filter((e) => e.status === 'active').length.toString()}
            icon={Users}
            tone="info"
            hint={`${employees.length} total`}
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

      {/* Recent activity */}
      <section>
        <h2 className="text-base font-semibold mb-3">Actividad reciente</h2>
        {activity.length === 0 ? (
          <Card className="text-sm text-muted-foreground text-center py-6">
            Sin actividad reciente.
          </Card>
        ) : (
          <Card className="p-0 overflow-hidden">
            <ul className="divide-y divide-border">
              {activity.map((a) => (
                <li key={a.id} className="p-3 flex items-start gap-3">
                  <Activity className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-medium">{a.user_name}</span>{' '}
                      <span className="text-muted-foreground">{a.action}</span>{' '}
                      <span className="text-xs text-muted-foreground">· {a.module}</span>
                    </p>
                    {a.details && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{a.details}</p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                    {new Date(a.timestamp).toLocaleString('es-ES', {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                </li>
              ))}
            </ul>
            <div className="p-2 text-center border-t border-border">
              <Link href="/auditoria" className="text-xs text-muted-foreground hover:text-foreground">
                Ver todo →
              </Link>
            </div>
          </Card>
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

function ApiStatusSection({ data }: { data: ApiCredRow[] | null }) {
  if (data === null) {
    return <SkeletonRow n={4} height="h-16" />;
  }
  if (data.length === 0) {
    return (
      <Card className="text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <Plug className="w-4 h-4" />
          <span>Sin APIs externas configuradas.</span>
        </div>
      </Card>
    );
  }
  return (
    <section>
      <h2 className="text-base font-semibold mb-3">APIs externas</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {data.map((a) => {
          const isOk = a.is_configured;
          const tone = isOk ? 'bg-emerald-500' : 'bg-red-500';
          return (
            <Card key={a.provider} className="p-3">
              <div className="flex items-center gap-2">
                <span className={`w-2.5 h-2.5 rounded-full ${tone}`} aria-hidden />
                <span className="font-medium capitalize text-sm">{a.provider}</span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                {isOk ? 'Configurada' : 'Sin credenciales'}
              </p>
              {a.updated_at && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {new Date(a.updated_at).toLocaleString('es-ES', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                </p>
              )}
            </Card>
          );
        })}
      </div>
    </section>
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
