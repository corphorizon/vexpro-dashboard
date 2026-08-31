'use client';

import { useEffect, useMemo, useState } from 'react';
import { StatCard } from '@/components/ui/stat-card';
import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { features } from '@/lib/business-model';
import { useApiCoexistence } from '@/lib/use-api-coexistence';
import { manualDepositsByChannel } from '@/lib/deposit-channels';
import { formatCurrency } from '@/lib/utils';
import { apiFetch } from '@/lib/api-fetch';
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
// Cada tarjeta se gatea por SU módulo: 'movements' para el flujo de clientes,
// 'income'/'expenses' para el resultado del mes, 'balances' para el total
// consolidado. Antes toda la fila 1 y el Total Consolidado colgaban de
// has('movements') — y 'movements' es uno de los módulos que
// blockedModules('company') apaga, así que en una empresa modo `company` la
// fila NUNCA se renderizaba: el skeleton dibujaba tres tarjetas que después se
// evaporaban y la home quedaba vacía (Horizon).
// ─────────────────────────────────────────────────────────────────────────────

export function AdminHome() {
  const { user } = useAuth();
  const {
    company,
    periods,
    getPeriodSummary,
    computeSaldoChain,
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
  // BUG-05: totales scopeados al SET de wallets pinneadas ('' → modo 'pinned'),
  // igual que /movimientos, /resumen-general y /balances. El pinning es la
  // selección curada de "qué wallets cuentan para este dashboard" — reemplaza
  // al viejo default_wallet_id único (Vex Pro tiene varias Coinsbuy de otras
  // sub-unidades; se pinnean solo las que pertenecen a este flujo).
  const currentCoexist = useApiCoexistence(currentPeriod ? [currentPeriod] : [], '');
  const prevCoexist = useApiCoexistence(prevPeriod ? [prevPeriod] : [], '');

  const consolidate = (
    summary: typeof currentSummary,
    coexist: typeof currentCoexist,
  ) => {
    if (!summary) return { deposits: 0, withdrawals: 0, netDeposit: 0 };
    const useDerivedBroker = coexist.useDerivedBroker;

    // Manual por canal desde el registro único (src/lib/deposit-channels.ts).
    const manualByChannel = manualDepositsByChannel(summary.deposits);
    const storedOther = manualByChannel.other;
    const deposits = useDerivedBroker
      ? coexist.apiDepositsTotal(manualByChannel) + storedOther
      : summary.totalDeposits;

    const storedBroker = summary.withdrawals.find((w) => w.category === 'broker')?.amount ?? 0;
    // Withdrawals — Kevin (2026-06-06, decisión final): los retiros reales
    // son los datos de Coinsbuy = API + manual Broker (suplemento Coinsbuy
    // cuando la API no alcanza a reportar). Comisiones IB / Prop Firm /
    // Otros son meramente informativos y NO entran al total.
    // Misma lógica en /movimientos y /resumen-general para que las tres
    // vistas coincidan.
    const withdrawals = useDerivedBroker
      ? coexist.apiWithdrawalsTotal + storedBroker
      : summary.totalWithdrawals;

    const netDeposit = deposits - withdrawals;

    return { deposits, withdrawals, netDeposit };
  };

  const cur = useMemo(() => consolidate(currentSummary, currentCoexist), [currentSummary, currentCoexist]);
  const prv = useMemo(() => consolidate(prevSummary, prevCoexist), [prevSummary, prevCoexist]);

  // ── Resultado del mes — CADENA CANÓNICA ───────────────────────────────
  // Ingresos / Egresos / Neto salen de computeSaldoChain(), que arma sus
  // insumos con buildDistributionInputs + applySnapshotOverrides: los mismos
  // números que ve /socios. Antes se recalculaban acá a mano desde las tablas
  // vivas (broker_pnl + other + propFirm + inversiones − egresos), lo que
  // (a) duplicaba la fórmula, (b) mostraba lo de HOY en un mes CERRADO
  // mientras /socios mostraba lo congelado, y (c) no aplicaba la
  // neutralización por modelo de negocio (una 'company' seguía sumando
  // broker_pnl y prop firm heredados).
  const saldoChain = useMemo(() => computeSaldoChain(), [computeSaldoChain]);
  const curChain = currentPeriod ? saldoChain.get(currentPeriod.id) ?? null : null;
  const prvChain = prevPeriod ? saldoChain.get(prevPeriod.id) ?? null : null;

  const pct = (now: number, prev: number) => {
    if (!prev) return null;
    return ((now - prev) / Math.abs(prev)) * 100;
  };

  const netDepositDelta = pct(cur.netDeposit, prv.netDeposit);
  const expensesDelta = curChain && prvChain
    ? pct(curChain.egresosNetos, prvChain.egresosNetos)
    : null;
  const withdrawalsDelta = pct(cur.withdrawals, prv.withdrawals);

  // ── Total Consolidado (suma de todos los canales) ─────────────────────
  // Pulls from /api/balances/total-consolidado, which calls Coinsbuy +
  // UniPayment APIs LIVE and, para el resto, recorre las ubicaciones VISIBLES
  // de channel_configs tomando el saldo del LIBRO (snapshot solo de respaldo)
  // — incluidas las custom_*, que la lista fija anterior nunca sumaba. Más
  // liquidez + inversiones. Así el número coincide con el pie de /balances
  // incluso antes de que el cron diario capture el snapshot de hoy.
  // Auto-refresh every 5 min while the tab is visible.
  const [totalConsolidado, setTotalConsolidado] = useState<number | null>(null);
  // ── PNL del mes (Kevin, 2026-08-31: «en vez de socios pon el dato del PNL
  // del mes») — la serie diaria del CRM (crm_daily_pnl). El signo se invierte
  // UNA sola vez en daily-pnl-query.ts (totals.brokerPnl); esta tarjeta lo
  // consume tal cual. null = sin datos, nunca $0.
  const [pnlMes, setPnlMes] = useState<{ value: number | null; dias: number }>({ value: null, dias: 0 });

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const hoy = new Date();
        const y = hoy.getUTCFullYear();
        const m = String(hoy.getUTCMonth() + 1).padStart(2, '0');
        const res = await apiFetch(`/api/admin/crm-daily-pnl?from=${y}-${m}-01&to=${y}-${m}-31`);
        if (!res.ok || cancel) return;
        const json = await res.json();
        // `totals.brokerPnl` YA viene con el signo del bróker invertido una
        // sola vez en daily-pnl-query.ts — no se re-invierte acá (registro
        // único del signo, la trampa que el repo persigue).
        const t = json.totals as { brokerPnl: number | null; daysWithData: number } | undefined;
        if (!cancel && t) setPnlMes({ value: t.brokerPnl, dias: t.daysWithData });
      } catch { /* sin datos: la tarjeta muestra — */ }
    })();
    return () => { cancel = true; };
  }, []);

  useEffect(() => {
    if (!company?.id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiFetch('/api/balances/total-consolidado');
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
  const has = (m: string) => hasModuleAccess(user, m, company?.active_modules, company?.business_model);
  // Una consultora no tiene depósitos de clientes: la fila 1 queda solo con
  // Ingresos / Egresos / Neto y el grid se ajusta para no dejar celdas vacías.
  const showNetDeposit = features(company?.business_model).netDeposit;

  // Gate POR TARJETA, no por fila: 'movements' está bloqueado en modo
  // 'company' (ver blockedModules) y colgar toda la fila de él dejaba la home
  // de una consultora vacía.
  const showFlowCards = showNetDeposit && has('movements');
  const showIncomeCard = !showNetDeposit && has('income');
  // En broker la fila entera sigue colgando de 'movements' — exactamente lo
  // que se ve hoy. En 'company' (donde 'movements' está bloqueado) manda el
  // módulo real de cada tarjeta.
  const showExpensesCard = showNetDeposit ? has('movements') : has('expenses');
  const showNetCard = showIncomeCard && showExpensesCard;
  const row1Count =
    (showFlowCards ? 3 : 0) + (showIncomeCard ? 1 : 0) + (showExpensesCard ? 1 : 0) + (showNetCard ? 1 : 0);

  // Ingresos / Egresos / Neto del mes: SIEMPRE de la cadena canónica.
  const operatingIncomeMonth = curChain?.ingresosNetos ?? 0;
  const expensesMonth = curChain?.egresosNetos ?? 0;
  const netMonth = curChain?.saldoAFavor ?? 0;

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
        row1Count > 0 ? <SkeletonRow n={row1Count} /> : null
      ) : row1Count > 0 ? (
        <section className={row1Count >= 4
          ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4'
          : 'grid grid-cols-1 sm:grid-cols-3 gap-4'}
        >
          {showFlowCards && (
            <>
              <StatCard
                label="Depósito Neto · mes"
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
            </>
          )}
          {showIncomeCard && (
            <StatCard
              label="Ingresos · mes"
              value={formatCurrency(operatingIncomeMonth)}
              icon={TrendingUp}
              tone="positive"
            />
          )}
          {showExpensesCard && (
            <StatCard
              label="Egresos · mes"
              value={formatCurrency(expensesMonth)}
              icon={Receipt}
              tone="warning"
              hint={deltaHint(expensesDelta, /* invertColor */ true)}
            />
          )}
          {showNetCard && (
            <StatCard
              label="Neto · mes"
              value={formatCurrency(netMonth)}
              icon={Wallet}
              tone={netMonth >= 0 ? 'positive' : 'negative'}
            />
          )}
        </section>
      ) : null}

      {/* Row 2 — Position snapshot
            Order: Total Consolidado · Inversiones · Liquidez · Socios
            (money figures grouped left, headcount card last) */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* 'balances' y no 'movements': la tarjeta es la suma de TODOS los
            balances (la misma de /balances) y en modo 'company' el módulo
            'movements' está bloqueado — con el gate viejo la consultora
            tampoco veía este número. */}
        {has('balances') && (
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
            label="PNL del mes (CRM)"
            value={pnlMes.value === null ? '—' : formatCurrency(pnlMes.value)}
            icon={Briefcase}
            tone={(pnlMes.value ?? 0) >= 0 ? 'positive' : 'negative'}
            hint={pnlMes.value === null ? 'sin datos' : `${pnlMes.dias} días con dato · bróker`}
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
