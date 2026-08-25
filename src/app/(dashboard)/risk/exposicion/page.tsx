'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /risk/exposicion — el riesgo vivo del bróker.
//
// Tres preguntas, en este orden:
//   1. ¿hay alguna cuenta a punto de liquidarse? (lo urgente)
//   2. ¿en qué está concentrada la exposición? (lo que puede doler mañana)
//   3. ¿cómo se reparte por familia y símbolo? (el detalle)
//
// ── LO QUE ESTA PANTALLA NO HACE, A PROPÓSITO ──────────────────────────────
// No muestra un total de dinero. Las cuentas Cent están EN CENTAVOS y las
// PropFirm llevan capital virtual de desafío: sumar sus flotantes daría
// -676.789 "dólares" que no existen. Cada importe va con su unidad al lado.
//
// El dato tiene hasta 15 minutos: se dice arriba, con la hora exacta. Una
// pantalla de riesgo que no diga de cuándo es su dato invita a decidir sobre
// algo viejo creyendo que es de ahora.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, AlertTriangle, Clock, Layers, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToasts } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { cn, formatNumber } from '@/lib/utils';
import { formatDateTime } from '@/lib/dates';
import type { RiskSnapshot, MarginRow, ExposureRow } from '@/lib/mt5-sync/risk-query';

/**
 * Un importe SIEMPRE con su unidad. Nunca se pinta un número de dinero solo:
 * en centavos y en dólares se ven igual y no lo son.
 */
function Money({ value, unit }: { value: number | null; unit: string }) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const cents = unit === 'cents';
  return (
    <span className="tabular-nums">
      <span className={cn(value < 0 ? 'text-negative' : value > 0 ? 'text-positive' : '')}>
        {formatNumber(value)}
      </span>
      <span className="ml-1 text-xs text-muted-foreground">{cents ? '¢' : 'USD'}</span>
    </span>
  );
}

export default function ExposicionPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const router = useRouter();
  const hasRiskAccess = useModuleAccess('risk');
  const { toast, ToastHost } = useToasts();

  const [data, setData] = useState<RiskSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (user === null) return;
    if (!hasRiskAccess) router.replace('/');
  }, [user, hasRiskAccess, router]);
  const accessDenied = user !== null && !hasRiskAccess;

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await apiFetch('/api/admin/risk-exposure');
      const body = await res.json();
      if (!res.ok || body?.success === false) throw new Error(body?.error ?? t('exposure.loadError'));
      setData(body);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('exposure.loadError'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!accessDenied) void load();
  }, [accessDenied, load]);

  if (accessDenied) return null;

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-64" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (!data || !data.snapshotAt) {
    return (
      <div className="space-y-6">
        {ToastHost}
        <PageHeader icon={Activity} title={t('exposure.title')} subtitle={t('exposure.subtitle')} />
        <EmptyState
          icon={Activity}
          title={t('exposure.noSnapshot')}
          description={t('exposure.noSnapshotHint')}
        />
      </div>
    );
  }

  const enRiesgo = [...data.critical, ...data.watch];

  return (
    <div className="space-y-6">
      {ToastHost}

      <PageHeader
        icon={Activity}
        title={t('exposure.title')}
        subtitle={t('exposure.subtitle')}
        actions={
          <Button variant="secondary" size="sm" loading={refreshing} onClick={() => void load(true)}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            {t('exposure.refresh')}
          </Button>
        }
      />

      {/* Una pantalla de riesgo tiene que decir de cuándo es su dato. */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted px-4 py-3 text-sm">
        <Clock className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground">
          {t('exposure.asOf', { when: formatDateTime(data.snapshotAt) })} · {t('exposure.moneyNotice')}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          icon={Layers}
          label={t('exposure.kpiPositions')}
          value={formatNumber(data.totalPositions)}
          hint={t('exposure.kpiPositionsHint')}
          emphasis
        />
        <StatCard
          icon={AlertTriangle}
          tone={data.critical.length > 0 ? 'negative' : 'neutral'}
          label={t('exposure.kpiCritical')}
          value={String(data.critical.length)}
          hint={t('exposure.kpiCriticalHint')}
        />
        <StatCard
          icon={Activity}
          tone={data.watch.length > 0 ? 'warning' : 'neutral'}
          label={t('exposure.kpiWatch')}
          value={String(data.watch.length)}
          hint={t('exposure.kpiWatchHint', { total: String(data.accountsWithMargin) })}
        />
      </div>

      {/* ── 1. Lo urgente: cuentas que pueden liquidarse ─────────────────── */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 pt-4">
          <CardTitle>{t('exposure.marginTitle')}</CardTitle>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('exposure.marginHint')}</p>
        </div>
        <DataTable<MarginRow>
          zebra
          density="compact"
          data={enRiesgo}
          empty={
            <EmptyState
              compact
              title={t('exposure.marginEmpty')}
              description={t('exposure.marginEmptyHint', { total: String(data.accountsWithMargin) })}
            />
          }
          columns={[
            {
              header: t('exposure.colLevel'),
              align: 'right',
              accessor: (m) => (
                <Badge variant={(m.margin_level ?? 0) < 100 ? 'danger' : 'warning'}>
                  {formatNumber(m.margin_level ?? 0)}%
                </Badge>
              ),
            },
            { header: t('exposure.colAccount'), accessor: (m) => String(m.login) },
            {
              header: t('exposure.colClient'),
              accessor: (m) => (
                <span className="text-xs">{m.email ?? t('exposure.noEmail')}</span>
              ),
            },
            {
              header: t('exposure.colFamily'),
              accessor: (m) => (
                <span className="text-xs">
                  {m.family}
                  {m.is_virtual && (
                    <span className="ml-1 text-muted-foreground">{t('exposure.virtual')}</span>
                  )}
                </span>
              ),
            },
            {
              header: t('exposure.colEquity'),
              align: 'right',
              accessor: (m) => <Money value={m.equity} unit={m.unit} />,
            },
            {
              header: t('exposure.colMargin'),
              align: 'right',
              accessor: (m) => <Money value={m.margin} unit={m.unit} />,
            },
            {
              header: t('exposure.colFloating'),
              align: 'right',
              accessor: (m) => <Money value={m.floating} unit={m.unit} />,
            },
          ]}
        />
      </Card>

      {/* ── 2. Concentración ─────────────────────────────────────────────── */}
      <Card>
        <CardTitle>{t('exposure.concentrationTitle')}</CardTitle>
        <p className="mt-1 text-xs text-muted-foreground">{t('exposure.concentrationHint')}</p>
        <ul className="mt-4 space-y-3">
          {data.concentration.map((c) => (
            <li key={c.symbol}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{c.symbol}</span>
                <span className="text-sm text-muted-foreground">
                  {t('exposure.concentrationRow', {
                    positions: formatNumber(c.positions),
                    share: String(c.share),
                    lots: formatNumber(c.netLots),
                  })}
                </span>
              </div>
              {/* La barra usa el PESO en posiciones, que sí es comparable. */}
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.min(100, c.share)}%` }}
                />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {c.byFamily.map((f) => (
                  <span key={f.family}>
                    {f.family}
                    {f.isVirtual ? ` ${t('exposure.virtual')}` : ''}:{' '}
                    <Money value={f.floating} unit={f.unit} />
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {/* ── 3. El detalle ────────────────────────────────────────────────── */}
      <Card className="p-0 overflow-hidden">
        <div className="px-4 pt-4">
          <CardTitle>{t('exposure.detailTitle')}</CardTitle>
          <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('exposure.detailHint')}</p>
        </div>
        <DataTable<ExposureRow>
          stickyHeader
          zebra
          density="compact"
          data={data.exposure}
          empty={<EmptyState compact title={t('exposure.detailEmpty')} />}
          columns={[
            {
              header: t('exposure.colFamily'),
              accessor: (r) => (
                <span className="text-xs">
                  {r.family}
                  {r.is_virtual && (
                    <span className="ml-1 text-muted-foreground">{t('exposure.virtual')}</span>
                  )}
                </span>
              ),
            },
            { header: t('exposure.colSymbol'), accessor: (r) => r.symbol },
            {
              header: t('exposure.colPositions'),
              align: 'right',
              accessor: (r) => <span className="tabular-nums">{formatNumber(r.positions)}</span>,
            },
            {
              header: t('exposure.colNetLots'),
              align: 'right',
              accessor: (r) => (
                <span
                  className={cn(
                    'tabular-nums',
                    (r.net_lots ?? 0) > 0 ? 'text-positive' : (r.net_lots ?? 0) < 0 ? 'text-negative' : '',
                  )}
                >
                  {formatNumber(r.net_lots ?? 0)}
                </span>
              ),
            },
            {
              header: t('exposure.colFloating'),
              align: 'right',
              accessor: (r) => <Money value={r.floating} unit={r.unit} />,
            },
            {
              header: t('exposure.colSwap'),
              align: 'right',
              accessor: (r) => <Money value={r.storage} unit={r.unit} />,
            },
          ]}
        />
      </Card>
    </div>
  );
}
