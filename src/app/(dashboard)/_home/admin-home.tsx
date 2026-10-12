'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { incompleteNotice } from '@/lib/distribution-inputs';
import { seriesState, type SeriesState } from '@/lib/chain-view';
import { useData } from '@/lib/data-context';
import { features } from '@/lib/business-model';
import { useApiCoexistence } from '@/lib/use-api-coexistence';
import { manualDepositsByChannel } from '@/lib/deposit-channels';
import { withdrawalChannelLabel } from '@/lib/withdrawal-channels';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { PageHeader } from '@/components/ui/page-header';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { QuickAccess } from './quick-access';
import {
  homeAlerts,
  pctChange,
  runningBalance,
  visibleAlerts,
  type AlertText,
  type ChecklistItemLike,
  type LoadState,
} from './home-view';

// ─────────────────────────────────────────────────────────────────────────────
// AdminHome — panel del admin de la empresa (y del superadmin viendo una).
//
// «Libro mayor» (2026-10-12): cabecera → franjas de KPIs → avisos → accesos.
//   · Franja 1, posición y resultado: Total consolidado (hero) · PNL del mes
//     (CRM) · Ingresos · Egresos · Neto del mes.
//   · Franja 2 (sólo bróker), flujo de clientes del mes: Depósito neto ·
//     Depósitos · Retiros · Inversiones · Liquidez.
//   · Avisos: estado del dato + checklist de cierre del mes abierto, por
//     severidad, 3 visibles y «ver todas (N)» (home-view.ts).
//
// Cada KPI se gatea por SU módulo: 'movements' para el flujo de clientes,
// 'income'/'expenses' para el resultado del mes, 'balances' para el total
// consolidado. Antes toda la fila de flujo y el Total Consolidado colgaban de
// has('movements') — y 'movements' es uno de los módulos que
// blockedModules('company') apaga, así que en una empresa modo `company` la
// fila NUNCA se renderizaba y la home quedaba vacía (Horizon).
//
// Lo que cambió en los números (todo «no lo sabemos ≠ cero», reglas §1.3):
//   · Total consolidado: el `catch` del fetch ponía 0 → «$0.00» con la red
//     caída. Ahora queda «—» y un aviso `bad`.
//   · Ingresos / Neto con la serie del CRM en vuelo: «—» + badge `stale`
//     «Cargando datos del CRM…» (antes, el texto suelto ocupando el valor).
//   · Flujo de clientes con /persisted-movements fallado: «—», no la suma
//     de lo manual con cara de total.
//   · Inversiones / Liquidez sin movimientos: «—» «Sin movimientos».
//
// DESCARTADO: mantener «Ingresos» y «Neto» sólo para `company` (como antes).
// Un bróker también tiene un resultado del mes y es el número que más se
// pregunta; ocultarlo obligaba a ir a /socios para verlo.
// ─────────────────────────────────────────────────────────────────────────────

export function AdminHome() {
  const { t } = useI18n();
  const { user } = useAuth();
  const {
    company,
    periods,
    getPeriodSummary,
    computeSaldoChain,
    getSnapshotDrifts,
    getInvestmentsData,
    getLiquidityData,
    partners,
    loading,
    autoSeriesStatus,
    truncatedSlices,
  } = useData();

  // ── Período en curso: el último no cerrado (o el más nuevo) ───────────
  const currentPeriod = useMemo(() => {
    if (!periods.length) return null;
    const open = [...periods].reverse().find((p) => !p.is_closed);
    return open ?? periods[periods.length - 1];
  }, [periods]);

  const prevPeriod = useMemo(() => {
    if (!currentPeriod) return null;
    const idx = periods.findIndex((p) => p.id === currentPeriod.id);
    return idx > 0 ? periods[idx - 1] : null;
  }, [periods, currentPeriod]);

  const currentSummary = currentPeriod ? getPeriodSummary(currentPeriod.id) : null;
  const prevSummary = prevPeriod ? getPeriodSummary(prevPeriod.id) : null;

  // ── API + manual — misma consolidación que /resumen-general y /movimientos.
  // BUG-05: totales scopeados al SET de wallets pinneadas ('' → modo 'pinned').
  const currentCoexist = useApiCoexistence(currentPeriod ? [currentPeriod] : [], '');
  const prevCoexist = useApiCoexistence(prevPeriod ? [prevPeriod] : [], '');

  /**
   * Retiros — Kevin (2026-06-06, decisión final): API + manual Broker.
   * Comisiones IB / Prop Firm / Otros son informativos y NO entran. Misma
   * lógica en /movimientos y /resumen-general.
   * null = no lo sabemos (sin resumen, o la API del período derivado falló /
   * todavía no respondió).
   */
  const consolidate = (summary: typeof currentSummary, coexist: typeof currentCoexist) => {
    if (!summary) return null;
    if (coexist.useDerivedBroker && coexist.apiFetchState !== 'ok') return null;
    const manualByChannel = manualDepositsByChannel(summary.deposits);
    const deposits = coexist.useDerivedBroker
      ? coexist.apiDepositsTotal(manualByChannel) + manualByChannel.other
      : summary.totalDeposits;
    const storedBroker = summary.withdrawals.find((w) => w.category === 'broker')?.amount ?? 0;
    const withdrawals = coexist.useDerivedBroker
      ? coexist.apiWithdrawalsTotal + storedBroker
      : summary.totalWithdrawals;
    return { deposits, withdrawals, netDeposit: deposits - withdrawals };
  };
  const cur = consolidate(currentSummary, currentCoexist);
  const prv = consolidate(prevSummary, prevCoexist);
  const flowState: LoadState = !currentSummary
    ? 'loading'
    : currentCoexist.useDerivedBroker && currentCoexist.apiFetchState !== 'ok'
      ? currentCoexist.apiFetchState === 'loading' ? 'loading' : 'failed'
      : 'ready';

  // ── Resultado del mes — CADENA CANÓNICA (computeSaldoChain: mismos
  // insumos y fórmula que /socios; congelado en los meses cerrados).
  const saldoChain = useMemo(() => computeSaldoChain(), [computeSaldoChain]);
  const curChain = currentPeriod ? saldoChain.get(currentPeriod.id) ?? null : null;
  const prvChain = prevPeriod ? saldoChain.get(prevPeriod.id) ?? null : null;
  // Serie del CRM todavía en vuelo o fallada (incidente 2026-10-05): el número
  // de la cadena es el fallback, no el dato.
  const ownSeries = seriesState(curChain, autoSeriesStatus, 'own');
  const chainSeries = seriesState(curChain, autoSeriesStatus, 'chain');

  // ── Total consolidado (/api/balances/total-consolidado) ───────────────
  // Coinsbuy + UniPayment EN VIVO y, para el resto, el saldo del LIBRO de las
  // ubicaciones visibles de channel_configs (incluidas las custom_*), más
  // liquidez + inversiones: coincide con el pie de /balances. El `total` ya
  // viene NETO de deuda (`tallyCash`); `owed` es sólo para decirlo.
  // Se refresca cada 5 min con la pestaña visible.
  const [total, setTotal] = useState<{ state: LoadState; value: number | null; owed: number }>({
    state: 'loading',
    value: null,
    owed: 0,
  });
  // PNL del mes (Kevin, 2026-08-31) — serie diaria del CRM. El signo se
  // invierte UNA sola vez en daily-pnl-query.ts (totals.brokerPnl).
  const [pnlMes, setPnlMes] = useState<{ state: LoadState; value: number | null; dias: number }>({
    state: 'loading',
    value: null,
    dias: 0,
  });
  // Checklist de cierre del mes abierto (registro único: period-close-checklist.ts).
  // Se guarda con el período al que pertenece: si el período cambia, lo
  // viejo no se muestra (y no hace falta un setState síncrono en el efecto).
  const [checklistRes, setChecklistRes] = useState<{
    periodId: string;
    state: LoadState;
    items: ChecklistItemLike[];
  } | null>(null);
  const [showAllAlerts, setShowAllAlerts] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const hoy = new Date();
        const y = hoy.getUTCFullYear();
        const m = String(hoy.getUTCMonth() + 1).padStart(2, '0');
        const res = await apiFetch(`/api/admin/crm-daily-pnl?from=${y}-${m}-01&to=${y}-${m}-31`);
        if (cancel) return;
        if (!res.ok) {
          setPnlMes({ state: 'failed', value: null, dias: 0 });
          return;
        }
        const json = await res.json();
        const tot = json.totals as { brokerPnl: number | null; daysWithData: number } | undefined;
        if (!cancel) {
          setPnlMes(tot ? { state: 'ready', value: tot.brokerPnl, dias: tot.daysWithData } : { state: 'failed', value: null, dias: 0 });
        }
      } catch {
        if (!cancel) setPnlMes({ state: 'failed', value: null, dias: 0 });
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    if (!company?.id) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiFetch('/api/balances/total-consolidado');
        const json = await res.json();
        if (cancelled) return;
        if (json.success) {
          setTotal({ state: 'ready', value: Number(json.total), owed: Number(json.owed) || 0 });
        } else {
          // Antes: el valor quedaba en «—» para siempre sin decir por qué.
          setTotal((prev) => ({ ...prev, state: 'failed', value: null }));
        }
      } catch {
        // Antes: setTotalConsolidado(0) — «$0.00» con la red caída.
        if (!cancelled) setTotal((prev) => ({ ...prev, state: 'failed', value: null }));
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

  const checklistPeriodId = currentPeriod && !currentPeriod.is_closed ? currentPeriod.id : null;
  useEffect(() => {
    if (!checklistPeriodId) return;
    let cancel = false;
    apiFetch(`/api/admin/period-close-checklist?period_id=${checklistPeriodId}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancel) return;
        setChecklistRes(
          json?.success
            ? { periodId: checklistPeriodId, state: 'ready', items: json.items ?? [] }
            : { periodId: checklistPeriodId, state: 'failed', items: [] },
        );
      })
      .catch(() => {
        if (!cancel) setChecklistRes({ periodId: checklistPeriodId, state: 'failed', items: [] });
      });
    return () => {
      cancel = true;
    };
  }, [checklistPeriodId]);
  const checklist = !checklistPeriodId
    ? null
    : checklistRes?.periodId === checklistPeriodId
      ? { state: checklistRes.state, items: checklistRes.items }
      : { state: 'loading' as const, items: [] };

  // ── Módulos ────────────────────────────────────────────────────────────
  const has = (m: string) => hasModuleAccess(user, m, company?.active_modules, company?.business_model);
  // Una consultora no tiene depósitos de clientes: sin franja de flujo.
  const showNetDeposit = features(company?.business_model).netDeposit;
  const showFlow = showNetDeposit && has('movements');
  const showIncome = has('income');
  // En bróker los egresos siguen colgando de 'movements' (lo de siempre); en
  // 'company' (donde 'movements' está bloqueado) manda el módulo real.
  const showExpenses = showNetDeposit ? has('movements') : has('expenses');
  const showNet = showIncome && showExpenses;
  const showTotal = has('balances');
  const showPnl = has('partners');

  const investments = getInvestmentsData();
  const liquidity = getLiquidityData();

  // ── KPIs ───────────────────────────────────────────────────────────────
  const prevMonthRef = t('home.prevMonth');
  const seriesBadge = (s: SeriesState | null) => (s ? { kind: s.badge, label: s.label } : undefined);

  const totalSub =
    total.state === 'failed'
      ? t('home.kpi.totalFailed')
      : total.owed !== 0
        ? t('home.kpi.totalNet')
        : t('home.kpi.totalSum');

  const positionKpis: KpiItem[] = [];
  if (showTotal) {
    positionKpis.push({
      key: 'total',
      label: t('home.kpi.total'),
      value: total.value,
      hero: true,
      sub: totalSub,
      missingBadge:
        total.state === 'loading'
          ? { kind: 'stale', label: t('home.kpi.loading') }
          : { kind: 'bad', label: t('home.kpi.readFailed') },
    });
  }
  if (showPnl) {
    positionKpis.push({
      key: 'pnl',
      label: t('home.kpi.pnl'),
      value: pnlMes.value,
      tone: 'sign',
      sub:
        pnlMes.state === 'ready' && pnlMes.value !== null
          ? t('home.kpi.pnlDays', { n: String(pnlMes.dias) })
          : pnlMes.state === 'failed'
            ? t('home.kpi.readFailed')
            : undefined,
      missingBadge:
        pnlMes.state === 'loading'
          ? { kind: 'stale', label: t('home.kpi.loading') }
          : pnlMes.state === 'failed'
            ? false
            : undefined,
    });
  }
  if (showIncome) {
    positionKpis.push({
      key: 'income',
      label: t('home.kpi.income'),
      value: curChain && !ownSeries ? curChain.ingresosNetos : null,
      missingBadge: seriesBadge(ownSeries),
      sub: currentPeriod?.label ?? undefined,
    });
  }
  if (showExpenses) {
    positionKpis.push({
      key: 'expenses',
      label: t('home.kpi.expenses'),
      value: curChain ? curChain.egresosNetos : null,
      delta: deltaOf(curChain?.egresosNetos ?? null, prvChain?.egresosNetos ?? null, 'down', prevMonthRef),
    });
  }
  if (showNet) {
    positionKpis.push({
      key: 'net',
      label: t('home.kpi.net'),
      value: curChain && !ownSeries ? curChain.saldoAFavor : null,
      tone: 'sign',
      missingBadge: seriesBadge(ownSeries),
      sub: t('home.kpi.netSub'),
    });
  }

  const missingWithdrawals = currentCoexist.withdrawalChannelsWithoutData.map((c) => withdrawalChannelLabel(c, t));
  const flowBadge =
    flowState === 'loading'
      ? { kind: 'stale' as const, label: t('home.kpi.loading') }
      : flowState === 'failed'
        ? { kind: 'bad' as const, label: t('home.kpi.readFailed') }
        : undefined;

  const flowKpis: KpiItem[] = [];
  if (showFlow) {
    flowKpis.push(
      {
        key: 'netDeposit',
        label: t('home.kpi.netDeposit'),
        value: cur?.netDeposit ?? null,
        tone: 'sign',
        missingBadge: flowBadge,
        delta: deltaOf(cur?.netDeposit ?? null, prv?.netDeposit ?? null, 'up', prevMonthRef),
      },
      {
        key: 'deposits',
        label: t('home.kpi.deposits'),
        value: cur?.deposits ?? null,
        missingBadge: flowBadge,
      },
      {
        key: 'withdrawals',
        label: t('home.kpi.withdrawals'),
        value: cur?.withdrawals ?? null,
        missingBadge: flowBadge,
        // Un canal de retiro que no se pudo leer NO está en el total: se dice
        // (reglas §1.2), igual que en /movimientos y /resumen-general.
        sub:
          missingWithdrawals.length > 0
            ? t('movements.withdrawalsMissingChannels', { channels: missingWithdrawals.join(', ') })
            : undefined,
        delta: deltaOf(cur?.withdrawals ?? null, prv?.withdrawals ?? null, 'down', prevMonthRef),
      },
    );
  }
  if (has('investments')) {
    flowKpis.push({
      key: 'investments',
      label: t('home.kpi.investments'),
      value: runningBalance(investments),
      missingBadge: false,
      sub: investments.length ? t('home.kpi.movements', { n: String(investments.length) }) : t('home.kpi.noMovements'),
    });
  }
  if (has('liquidity')) {
    flowKpis.push({
      key: 'liquidity',
      label: t('home.kpi.liquidity'),
      value: runningBalance(liquidity),
      missingBadge: false,
      sub: liquidity.length ? t('home.kpi.movements', { n: String(liquidity.length) }) : t('home.kpi.noMovements'),
    });
  }

  // ── Avisos ─────────────────────────────────────────────────────────────
  const drifts = useMemo(() => getSnapshotDrifts(), [getSnapshotDrifts]);
  const totalPct = partners.reduce((s, p) => s + p.percentage, 0);
  const alerts = homeAlerts({
    totalState: showTotal ? total.state : null,
    monthSeries: chainSeries,
    monthNotice: incompleteNotice(curChain),
    withdrawalChannelsWithoutData: showFlow && flowState === 'ready' ? missingWithdrawals : [],
    truncatedSlices,
    driftPeriods: Array.from(new Set(drifts.map((d) => d.periodLabel))),
    checklist,
    periodLabel: currentPeriod?.label ?? null,
  });
  if (has('partners') && partners.length > 0 && Math.abs(totalPct - 1) > 0.001) {
    alerts.push({
      id: 'partners-pct',
      kind: 'pend',
      title: { key: 'partners.percentageWarning', params: { pct: (totalPct * 100).toFixed(1) } },
      href: '/socios',
    });
  }
  const { shown: shownAlerts, hidden: hiddenAlerts } = visibleAlerts(alerts, showAllAlerts);
  const textOf = (x: AlertText) => ('text' in x ? x.text : t(x.key, x.params));

  const loadingFirst = loading && !currentSummary;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <PageHeader
        title={t('home.greeting', { name: user?.name?.split(' ')[0] ?? '' })}
        subtitle={
          company?.name
            ? t('home.subtitle', { company: company.name }) + (currentPeriod ? ` · ${currentPeriod.label}` : '')
            : t('home.subtitleNoCompany')
        }
      />

      {loadingFirst ? (
        <Skeleton className="h-[92px]" />
      ) : positionKpis.length > 0 ? (
        <section aria-label={t('home.positionAria')}>
          <KpiStrip items={positionKpis} />
        </section>
      ) : null}

      {flowKpis.length > 0 &&
        (loadingFirst ? (
          <Skeleton className="h-[92px]" />
        ) : (
          <section aria-label={t('home.flowAria')}>
            <KpiStrip items={flowKpis} />
          </section>
        ))}

      {alerts.length > 0 && (
        <section aria-label={t('home.alertsAria')} className="space-y-2">
          {shownAlerts.map((a) => (
            <Notice
              key={a.id}
              kind={a.kind}
              title={a.count != null ? `${a.count} · ${textOf(a.title)}` : textOf(a.title)}
              action={
                a.href ? (
                  <Link href={a.href} className="text-[13px] font-medium text-brand-ink underline-offset-2 hover:underline">
                    {t('home.alert.review')}
                  </Link>
                ) : undefined
              }
            >
              {a.detail ? <span className="break-words text-[12px]">{textOf(a.detail)}</span> : null}
            </Notice>
          ))}
          {(hiddenAlerts > 0 || showAllAlerts) && alerts.length > 3 && (
            <button
              type="button"
              onClick={() => setShowAllAlerts((v) => !v)}
              aria-expanded={showAllAlerts}
              className="inline-flex h-8 items-center rounded-ui-md px-2 text-[13px] font-medium text-text-2 hover:bg-surface-hover hover:text-foreground"
            >
              {showAllAlerts ? t('home.alert.showLess') : t('home.alert.showAll', { n: String(alerts.length) })}
            </button>
          )}
        </section>
      )}

      <QuickAccess heading={t('home.quickAccess')} />
    </div>
  );
}

/** Delta % vs. el mes anterior para el KPI, o nada si no hay base. */
function deltaOf(
  now: number | null,
  prev: number | null,
  goodWhen: 'up' | 'down',
  ref: string,
): KpiItem['delta'] {
  const pct = pctChange(now, prev);
  return pct === null ? undefined : { pct, goodWhen, ref };
}
