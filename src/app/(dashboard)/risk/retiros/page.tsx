'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /risk/retiros — cola de revisión de retiros pendientes.
//
// La pantalla responde, en este orden: cuánto dinero está esperando decisión,
// cuántos casos piden atención de verdad (banda alta) y cuáles llevan días
// parados. Después, la tabla ordenada por riesgo.
//
// DOS COSAS QUE LA UI NO DEBE SUGERIR NUNCA:
//  1. Que el score decide. Es orientativo; la fila que manda es la persona.
//  2. Que aprobar acá ejecuta el retiro. No lo hace: el dashboard es
//     solo-lectura sobre el CRM y la acción efectiva se sigue haciendo allá.
//     Por eso el aviso vive fijo arriba y no en un tooltip escondido.
//
// El filtrado va al servidor (ver `api.ts`): el histórico son decenas de miles
// de filas y el score se calcula por fila, así que no se traen todas para
// descartarlas en el navegador.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ShieldAlert, Search, Eye, Clock, Wallet, Info } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { useToasts } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { useData } from '@/lib/data-context';
import { cn, formatCurrency } from '@/lib/utils';
import { formatDateTime } from '@/lib/dates';
import { loadQueue, type QueueItem, type CalibrationInfo, type RiskBand } from '@/lib/withdrawal-risk/api';

type BandFilter = 'all' | RiskBand;

const BAND_FILTERS: { value: BandFilter; key: string }[] = [
  { value: 'all', key: 'wdReview.filterAll' },
  { value: 'high', key: 'wdReview.filterHigh' },
  { value: 'medium', key: 'wdReview.filterMedium' },
  { value: 'low', key: 'wdReview.filterLow' },
];

const BAND_VARIANT: Record<RiskBand, 'success' | 'warning' | 'danger'> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
};

export default function RevisionRetirosPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const router = useRouter();
  const hasRiskAccess = useModuleAccess('risk');
  const { company } = useData();
  const { toast, ToastHost } = useToasts();

  const [items, setItems] = useState<QueueItem[]>([]);
  const [counts, setCounts] = useState<Record<RiskBand, number>>({ low: 0, medium: 0, high: 0 });
  const [calibration, setCalibration] = useState<CalibrationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [band, setBand] = useState<BandFilter>('all');
  const [query, setQuery] = useState('');
  // Lo que se manda al servidor. Se separa de `query` para no disparar una
  // consulta por tecla: se confirma con Enter o con el botón.
  const [appliedQuery, setAppliedQuery] = useState('');

  useEffect(() => {
    if (user === null) return;
    if (!hasRiskAccess) router.replace('/');
  }, [user, hasRiskAccess, router]);
  const accessDenied = user !== null && !hasRiskAccess;

  const fetchQueue = useCallback(
    (bandFilter: BandFilter, q: string) => {
      let alive = true;
      setLoading(true);
      loadQueue({ band: bandFilter === 'all' ? null : bandFilter, q: q || null })
        .then((res) => {
          if (!alive) return;
          setItems(res.items ?? []);
          setCounts(res.counts ?? { low: 0, medium: 0, high: 0 });
          setCalibration(res.calibration ?? null);
        })
        .catch((err: unknown) => {
          if (alive) toast.error(err instanceof Error ? err.message : t('wdReview.loadError'));
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
      return () => {
        alive = false;
      };
    },
    // toast y t son estables por render; incluirlos sólo agregaría ruido.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (accessDenied) return;
    return fetchQueue(band, appliedQuery);
  }, [band, appliedQuery, accessDenied, fetchQueue]);

  const money = (n: number, currency?: string) =>
    formatCurrency(n, (currency === 'USDT' ? 'USD' : currency) || company?.currency || 'USD');

  // ── KPIs de la cola ───────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const sum = items.reduce((s, i) => s + (i.withdrawal.requested_amount ?? 0), 0);
    const highSum = items
      .filter((i) => i.score.band === 'high')
      .reduce((s, i) => s + (i.withdrawal.requested_amount ?? 0), 0);
    const stale = items.filter((i) => (i.ageDays ?? 0) >= 7);
    return {
      count: items.length,
      sum,
      highCount: items.filter((i) => i.score.band === 'high').length,
      highSum,
      staleCount: stale.length,
      staleSum: stale.reduce((s, i) => s + (i.withdrawal.requested_amount ?? 0), 0),
    };
  }, [items]);

  if (accessDenied) return null;

  const hasFilters = band !== 'all' || appliedQuery !== '';

  return (
    <div className="space-y-6">
      {ToastHost}

      <PageHeader
        icon={ShieldAlert}
        title={t('wdReview.title')}
        subtitle={t('wdReview.subtitle')}
      />

      {/* El aviso es parte del control, no decoración: quien use la pantalla
          tiene que saber que registrar una decisión no mueve el dinero. */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-info/10 px-4 py-3 text-sm">
        <Info className="h-4 w-4 shrink-0 mt-0.5 text-info" aria-hidden />
        <p className="text-muted-foreground">{t('wdReview.disclaimer')}</p>
      </div>

      {loading && items.length === 0 ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
          <Skeleton className="h-10 w-full max-w-md" />
          <Skeleton className="h-80" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              icon={Wallet}
              label={t('wdReview.kpiPending')}
              value={money(kpis.sum)}
              hint={t('wdReview.kpiPendingHint', { count: String(kpis.count) })}
              emphasis
            />
            <StatCard
              icon={ShieldAlert}
              tone={kpis.highCount > 0 ? 'negative' : 'neutral'}
              label={t('wdReview.kpiHigh')}
              value={String(kpis.highCount)}
              hint={t('wdReview.kpiHighHint', { amount: money(kpis.highSum) })}
            />
            <StatCard
              icon={Clock}
              tone={kpis.staleCount > 0 ? 'warning' : 'neutral'}
              label={t('wdReview.kpiStale')}
              value={String(kpis.staleCount)}
              hint={t('wdReview.kpiStaleHint', { amount: money(kpis.staleSum) })}
            />
          </div>

          {/* ── Filtros ───────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-2">
              {BAND_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setBand(f.value)}
                  aria-pressed={band === f.value}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium rounded-md border transition-colors',
                    band === f.value
                      ? 'bg-primary text-white border-primary'
                      : 'border-border hover:bg-muted',
                  )}
                >
                  {t(f.key)}
                  {f.value !== 'all' && counts[f.value] > 0 ? ` (${counts[f.value]})` : ''}
                </button>
              ))}
            </div>

            <form
              className="relative w-full sm:max-w-xs"
              onSubmit={(e) => {
                e.preventDefault();
                setAppliedQuery(query.trim());
              }}
            >
              <Search
                className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('wdReview.searchPlaceholder')}
                aria-label={t('wdReview.searchPlaceholder')}
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm"
              />
            </form>
          </div>

          <Card className="p-0 overflow-hidden">
            <DataTable
              stickyHeader
              zebra
              data={items}
              empty={
                <EmptyState
                  compact
                  icon={ShieldAlert}
                  title={hasFilters ? t('wdReview.emptyFiltered') : t('wdReview.emptyNone')}
                  description={
                    hasFilters ? t('wdReview.emptyFilteredHint') : t('wdReview.emptyNoneHint')
                  }
                />
              }
              columns={[
                {
                  header: t('wdReview.colClient'),
                  accessor: (i) => (
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {i.withdrawal.username ?? t('wdReview.noUser')}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {i.withdrawal.email ?? i.withdrawal.external_id}
                      </p>
                    </div>
                  ),
                },
                {
                  header: t('wdReview.colAmount'),
                  align: 'right',
                  accessor: (i) => (
                    <span className="font-semibold tabular-nums">
                      {money(i.withdrawal.requested_amount ?? 0, i.withdrawal.coin ?? undefined)}
                    </span>
                  ),
                },
                {
                  header: t('wdReview.colMethod'),
                  accessor: (i) => <span className="text-xs">{i.paymentMethod}</span>,
                },
                {
                  header: t('wdReview.colRequested'),
                  accessor: (i) => (
                    <div>
                      <p className="text-xs">{formatDateTime(i.withdrawal.requested_at)}</p>
                      <p
                        className={cn(
                          'text-xs',
                          (i.ageDays ?? 0) >= 7 ? 'text-warning' : 'text-muted-foreground',
                        )}
                      >
                        {t('wdReview.ageDays', { days: String(Math.floor(i.ageDays ?? 0)) })}
                      </p>
                    </div>
                  ),
                },
                {
                  header: t('wdReview.colScore'),
                  align: 'right',
                  accessor: (i) => (
                    <div className="flex items-center justify-end gap-2">
                      <span className="tabular-nums font-semibold">{i.score.approvalScore}</span>
                      <Badge variant={BAND_VARIANT[i.score.band]}>
                        {t(`wdReview.band.${i.score.band}`)}
                      </Badge>
                    </div>
                  ),
                },
                {
                  header: t('wdReview.colMainFactor'),
                  accessor: (i) => {
                    const worst = i.score.factors.find((f) => f.impact === 'down');
                    return (
                      <span className="text-xs text-muted-foreground">
                        {worst ? worst.label : t('wdReview.noRedFlags')}
                      </span>
                    );
                  },
                },
                {
                  header: t('wdReview.colDecision'),
                  accessor: (i) =>
                    i.review?.decision ? (
                      <Badge variant={i.review.decision === 'approve' ? 'success' : 'neutral'}>
                        {t(`wdReview.decision.${i.review.decision}`)}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t('wdReview.undecided')}</span>
                    ),
                },
                {
                  header: '',
                  align: 'right',
                  accessor: (i) => (
                    <Link
                      href={`/risk/retiros/${encodeURIComponent(i.withdrawal.external_id)}`}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <Eye className="h-3.5 w-3.5" aria-hidden />
                      {t('wdReview.review')}
                    </Link>
                  ),
                },
              ]}
            />
          </Card>

          {calibration && (
            <p className="text-xs text-muted-foreground">
              {t('wdReview.calibrationFooter', {
                window: calibration.window,
                n: String(calibration.n),
                base: (calibration.baseRejectionRate * 100).toFixed(2),
              })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
