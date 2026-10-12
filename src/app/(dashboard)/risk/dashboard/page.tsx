'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { ShieldCheck, FileSearch, ShieldAlert, Activity, ArrowRight } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { UnitAmount } from '@/components/risk/unit-amount';
import { bandKind, marginKind } from '@/components/risk/risk-kinds';
import { snapshotFreshness } from '@/components/risk/risk-format';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useI18n } from '@/lib/i18n';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { loadQueue, type QueueItem } from '@/lib/withdrawal-risk/api';
import type { RiskSnapshot, MarginRow } from '@/lib/mt5-sync/risk-query';
import type { RevisionSummary } from '@/components/charts/risk-revisions-chart';
import { cn } from '@/lib/utils';
import { displayCurrency, queueKpis, sectionCounts, urgentQueue } from '../retiros/queue-view';
import { marginLevelText } from '../exposicion/exposure-view';

// recharts on-demand (patrón PERF-03).
const RiskRevisionsChart = dynamic(
  () => import('@/components/charts/risk-revisions-chart').then((m) => m.RiskRevisionsChart),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[260px]" />,
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// /risk/dashboard — landing page for support / risk-only roles.
//
// Limpieza 2026-08-03 (decisión Kevin): se removieron los KPIs hard-coded a
// cero, las listas siempre-vacías y los tiles placeholder que esperaban un
// CRM aún no conectado — la página muestra SOLO datos reales.
//
// ── «LIBRO MAYOR» (2026-10-12) ──────────────────────────────────────────────
// La regla de agosto se mantiene: todo lo nuevo sale de endpoints que YA
// alimentan otras pantallas del módulo, nada se inventa ni se pone en cero.
//   · KpiStrip: retiros por revisar y monto en juego (la misma cola de
//     /risk/retiros, `loadQueue` sin filtros, con los mismos cálculos de
//     queue-view.ts), posiciones abiertas y cuentas bajo el 100 % de margen
//     (la foto de /risk/exposicion).
//   · Cada fuente carga por separado: si una falla (o el rol no la puede
//     leer), su KPI muestra «—» con «Sin dato» y un aviso — nunca un 0, que
//     se leería como «no hay nada que revisar».
//   · Paneles con FinTable: los 5 retiros más urgentes (banda alta primero) y
//     las 5 cuentas con peor margen, cada uno con su «ver todo».
//
// DESCARTADO:
//   · «Exposición neta» en DINERO: /risk/exposicion no suma dinero entre
//     familias a propósito (Cent en centavos, PropFirm virtual: sumar daría
//     cientos de miles de dólares que no existen, reglas §3 G3). El KPI de
//     exposición es el CONTEO de posiciones, que sí se puede sumar.
//   · Pedir la cola en el server de esta página: es la misma API que ya usa
//     la cola; un segundo camino para el mismo número es el modo de falla nº 1.
// ─────────────────────────────────────────────────────────────────────────────

type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error' };

const TOP_N = 5;

export default function RiskDashboardPage() {
  const { user } = useAuth();
  const { company } = useData();
  const { t } = useI18n();
  const canAccess = useModuleAccess('risk');

  const [queue, setQueue] = useState<Load<QueueItem[]>>({ state: 'loading' });
  const [snapshot, setSnapshot] = useState<Load<RiskSnapshot>>({ state: 'loading' });
  // Historial REAL de revisiones Prop Firm — misma fuente que
  // /risk/retiros-propfirm (/api/risk/revisions). Cada payload trae
  // savedAt + verdict; alcanza para la evolución mensual por veredicto.
  const [revisions, setRevisions] = useState<Load<RevisionSummary[]>>({ state: 'loading' });
  const [loadedAt, setLoadedAt] = useState(() => Date.now());

  useEffect(() => {
    if (user === null || !canAccess) return;
    let cancelled = false;

    loadQueue()
      .then((res) => {
        if (!cancelled) setQueue({ state: 'ok', data: res.items ?? [] });
      })
      .catch(() => {
        if (!cancelled) setQueue({ state: 'error' });
      });

    (async () => {
      try {
        const res = await apiFetch('/api/admin/risk-exposure');
        const body = await res.json();
        if (cancelled) return;
        if (res.ok && body?.success !== false && body?.snapshotAt) {
          setSnapshot({ state: 'ok', data: body as RiskSnapshot });
          setLoadedAt(Date.now());
        } else setSnapshot({ state: 'error' });
      } catch {
        if (!cancelled) setSnapshot({ state: 'error' });
      }
    })();

    (async () => {
      try {
        const res = await apiFetch('/api/risk/revisions');
        const json = await res.json();
        if (cancelled) return;
        if (res.ok && json.success && Array.isArray(json.revisions)) {
          setRevisions({
            state: 'ok',
            data: json.revisions.map(
              (r: { payload: { savedAt: string; verdict: RevisionSummary['verdict'] } }) => ({
                savedAt: r.payload?.savedAt,
                verdict: r.payload?.verdict ?? null,
              }),
            ),
          });
        } else {
          // Antes un fallo (o un 403 del rol) dejaba el gráfico VACÍO, igual
          // que «no hubo revisiones». Son cosas distintas.
          setRevisions({ state: 'error' });
        }
      } catch {
        if (!cancelled) setRevisions({ state: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, canAccess]);

  const items = queue.state === 'ok' ? queue.data : null;
  const kpisQ = useMemo(() => (items ? queueKpis(items) : null), [items]);
  const secs = useMemo(() => (items ? sectionCounts(items) : null), [items]);
  const urgent = useMemo(() => (items ? urgentQueue(items, TOP_N) : []), [items]);
  const snap = snapshot.state === 'ok' ? snapshot.data : null;
  const fresh = snap ? snapshotFreshness(snap.snapshotAt, loadedAt) : null;
  const worstMargin = useMemo<MarginRow[]>(() => (snap ? snap.critical.slice(0, TOP_N) : []), [snap]);

  if (!canAccess) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <p className="text-[13px] text-text-3">403 · Acceso restringido</p>
      </div>
    );
  }

  const companyCurrency = company?.currency || 'USD';
  const loadingBadge = { kind: 'stale' as const, label: t('riskLm.loading') };
  const badgeFor = (s: Load<unknown>) => (s.state === 'loading' ? loadingBadge : undefined);

  const kpis: KpiItem[] = [
    {
      key: 'toReview',
      label: t('riskLm.kpiToReview'),
      value: items ? items.length : null,
      format: 'count',
      sub: secs && kpisQ ? t('riskLm.kpiToReviewSub', { esc: String(secs.escalated), high: String(kpisQ.high.count) }) : undefined,
      missingBadge: badgeFor(queue),
    },
    {
      key: 'atStake',
      label: t('riskLm.kpiAtStake'),
      value: kpisQ ? kpisQ.total.sum : null,
      currency: companyCurrency,
      hero: true,
      sub:
        kpisQ && kpisQ.total.missing > 0
          ? t('riskLm.missingAmount', { n: String(kpisQ.total.missing) })
          : kpisQ
            ? t('wdReview.kpiPendingHint', { count: String(kpisQ.total.count) })
            : undefined,
      // Con la cola cargada y vacía la suma es null: «—» con el conteo en 0
      // abajo, sin badge de «Sin dato» (sí hay dato: no hay retiros).
      missingBadge: queue.state === 'ok' ? false : badgeFor(queue),
    },
    {
      key: 'positions',
      label: t('riskLm.kpiExposure'),
      value: snap ? snap.totalPositions : null,
      format: 'count',
      sub: t('riskLm.kpiExposureSub'),
      staleAt: fresh?.stale ? snap?.snapshotAt : undefined,
      missingBadge: badgeFor(snapshot),
    },
    {
      key: 'alerts',
      label: t('riskLm.kpiMarginAlerts'),
      value: snap ? snap.critical.length : null,
      format: 'count',
      sub: snap ? t('riskLm.kpiMarginAlertsSub', { n: String(snap.watch.length) }) : undefined,
      staleAt: fresh?.stale ? snap?.snapshotAt : undefined,
      missingBadge: badgeFor(snapshot),
    },
  ];

  const urgentCols: FinColumn<QueueItem>[] = [
    {
      key: 'client',
      header: t('wdReview.colClient'),
      cell: (i) => i.withdrawal.username ?? t('wdReview.noUser'),
      meta: (i) => i.withdrawal.email ?? i.withdrawal.external_id,
      mobileMeta: (i) => <StatusBadge kind={bandKind(i.score.band)} label={t(`wdReview.band.${i.score.band}`)} />,
    },
    {
      key: 'amount',
      header: t('wdReview.colAmount'),
      kind: 'money',
      value: (i) => i.withdrawal.requested_amount,
      cell: (i) => (
        <Money
          value={i.withdrawal.requested_amount}
          currency={displayCurrency(i.withdrawal.coin, companyCurrency)}
          nullLabel={t('ui.noData')}
          className="font-medium"
        />
      ),
    },
    {
      key: 'band',
      header: t('wdReview.colScore'),
      hideSm: true,
      cell: (i) => (
        <span className="inline-flex items-center gap-2">
          <span className={cn(NUM_CLASS, 'w-7 text-right font-semibold')}>{i.score.approvalScore}</span>
          <StatusBadge kind={bandKind(i.score.band)} label={t(`wdReview.band.${i.score.band}`)} />
        </span>
      ),
    },
    {
      key: 'age',
      header: t('riskLm.colAge'),
      align: 'right',
      hideSm: true,
      cell: (i) => (
        <span className={cn(NUM_CLASS, 'text-[12.5px] text-text-2')}>
          {i.ageDays === null ? '—' : t('wdReview.ageDays', { days: String(Math.floor(i.ageDays)) })}
        </span>
      ),
    },
  ];

  const marginCols: FinColumn<MarginRow>[] = [
    {
      key: 'level',
      header: t('exposure.colLevel'),
      cell: (m) => <StatusBadge kind={marginKind('critical')} label={marginLevelText(m.margin_level)} />,
      width: '120px',
    },
    {
      key: 'account',
      header: t('exposure.colAccount'),
      cell: (m) => <span className="font-mono text-[12px]">{m.login}</span>,
      meta: (m) => `${m.email ?? t('exposure.noEmail')} · ${m.family}`,
    },
    {
      key: 'equity',
      header: t('exposure.colEquity'),
      kind: 'money',
      value: (m) => m.equity,
      cell: (m) => <UnitAmount value={m.equity} unit={m.unit} className="font-medium" />,
    },
  ];

  const seeAll = (href: string, label: string) => (
    <Link href={href} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-text-2 hover:text-foreground">
      {label}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Risk Management"
        subtitle={`Hola${user?.name ? `, ${user.name.split(' ')[0]}` : ''}. Panel de soporte y control.`}
        icon={ShieldCheck}
      />

      <KpiStrip items={kpis} />

      {(queue.state === 'error' || snapshot.state === 'error') && (
        <Notice kind="pend" title={t('riskLm.sourceErrorTitle')}>
          {[
            queue.state === 'error' ? t('riskLm.sourceErrorQueue') : null,
            snapshot.state === 'error' ? t('riskLm.sourceErrorSnapshot') : null,
          ]
            .filter(Boolean)
            .join(' ')}
        </Notice>
      )}

      <div className="grid grid-cols-1 gap-4 min-[1100px]:grid-cols-2">
        <Panel
          title={t('riskLm.urgentTitle')}
          hint={t('riskLm.urgentHint')}
          actions={seeAll('/risk/retiros', t('riskLm.seeQueue'))}
          flush
        >
          {queue.state === 'loading' ? (
            <div className="p-4">
              <Skeleton className="h-40" />
            </div>
          ) : (
            <FinTable<QueueItem>
              caption={t('riskLm.urgentTitle')}
              columns={urgentCols}
              rows={urgent}
              rowKey={(i) => i.withdrawal.external_id}
              // «Mostrando 5 de N»: un top sin decir de cuántos se lee como
              // la cola entera (reglas §1.2).
              totalCount={items ? items.length : null}
              empty={queue.state === 'error' ? t('ui.noData') : t('wdReview.emptyNone')}
            />
          )}
        </Panel>

        <Panel
          title={t('riskLm.marginTitle')}
          hint={t('exposure.kpiCriticalHint')}
          actions={seeAll('/risk/exposicion', t('riskLm.seeExposure'))}
          flush
        >
          {snapshot.state === 'loading' ? (
            <div className="p-4">
              <Skeleton className="h-40" />
            </div>
          ) : (
            <FinTable<MarginRow>
              caption={t('riskLm.marginTitle')}
              columns={marginCols}
              rows={worstMargin}
              rowKey={(m) => String(m.login)}
              totalCount={snap ? snap.critical.length : null}
              empty={snapshot.state === 'error' ? t('ui.noData') : t('exposure.marginEmpty')}
            />
          )}
        </Panel>
      </div>

      {/* Revisiones Prop Firm por mes (datos reales del historial guardado) */}
      <Panel
        title="Revisiones Prop Firm por mes"
        hint="Historial guardado, apilado por veredicto"
        actions={seeAll('/risk/retiros-propfirm', 'Ver historial')}
      >
        {revisions.state === 'loading' ? (
          <Skeleton className="h-[260px]" />
        ) : revisions.state === 'error' ? (
          <p className="py-8 text-center text-[13px] text-text-3">{t('riskLm.revisionsError')}</p>
        ) : (
          <RiskRevisionsChart revisions={revisions.data} />
        )}
      </Panel>

      {/* Quick access — sólo accesos con destino real (decisión Kevin
          2026-08-03): los tiles "Usuarios"/"Actividad Sospechosa" eran
          placeholders del CRM aún no conectado. */}
      <section>
        <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.005em] text-foreground">Accesos rápidos</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <QuickTile href="/risk/retiros" label={t('wdReview.title')} Icon={ShieldAlert} />
          <QuickTile href="/risk/exposicion" label={t('exposure.title')} Icon={Activity} />
          <QuickTile href="/risk/retiros-propfirm" label="Retiros Prop Firm" Icon={FileSearch} />
        </div>
      </section>
    </div>
  );
}

function QuickTile({
  href,
  label,
  Icon,
}: {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-ui-lg border border-border bg-card p-3 shadow-1 hover:bg-row-hover"
    >
      <span className="rounded-ui-md bg-brand-tint p-2 text-brand-ink">
        <Icon className="size-4" />
      </span>
      <span className="truncate text-[13.5px] font-medium text-foreground">{label}</span>
    </Link>
  );
}
