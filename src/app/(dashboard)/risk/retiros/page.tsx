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
import { ShieldAlert, Search, Eye, Clock, Wallet, Info, Check, X, History, Zap } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardTitle } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { useToasts } from '@/components/ui/toast';
import {
  useTablePage, TableSearch, TablePager, TableCsvButton,
} from '@/components/ui/table-toolbar';
import { SectionTabs } from '@/components/ui/section-tabs';
import {
  QuickDecisionDialog,
  type QuickDecisionTarget,
  type QuickDecision,
} from '@/components/withdrawal/quick-decision-dialog';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { useData } from '@/lib/data-context';
import { cn, formatCurrency } from '@/lib/utils';
import { formatDateTime } from '@/lib/dates';
import { roleCanApproveWithdrawal } from '@/lib/roles';
import {
  loadQueue,
  saveDecision,
  type QueueItem,
  type ResolvedItem,
  type CalibrationInfo,
  type RiskBand,
} from '@/lib/withdrawal-risk/api';

type BandFilter = 'all' | RiskBand;

const BAND_FILTERS: { value: BandFilter; key: string }[] = [
  { value: 'all', key: 'wdReview.filterAll' },
  { value: 'high', key: 'wdReview.filterHigh' },
  { value: 'medium', key: 'wdReview.filterMedium' },
  { value: 'low', key: 'wdReview.filterLow' },
];

/**
 * Color del estado final. `pending` sigue existiendo acá: un retiro puede pasar
 * por estados intermedios (IN_PROCESS, ON_HOLD) antes de COMPLETED o REJECTED,
 * y mostrarlo en gris dice "esto todavía se está moviendo" sin fingir que ya
 * terminó.
 */
const STATUS_VARIANT = (norm: string): 'success' | 'warning' | 'danger' | 'neutral' => {
  if (norm === 'completed') return 'success';
  if (norm === 'rejected' || norm === 'failed') return 'danger';
  if (norm === 'pending') return 'warning';
  return 'neutral';
};

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
  const [instant, setInstant] = useState<QueueItem[]>([]);
  const [resolved, setResolved] = useState<ResolvedItem[]>([]);
  // Qué sección se está mirando. No va a la URL: es una preferencia de lectura
  // de un momento, y meterla al historial rompería el botón Atrás.
  const [seccion, setSeccion] = useState<'solicitados' | 'instant' | 'historial'>('solicitados');
  // El retiro sobre el que está abierto el diálogo de decisión rápida.
  const [target, setTarget] = useState<QuickDecisionTarget | null>(null);
  const [counts, setCounts] = useState<Record<RiskBand, number>>({ low: 0, medium: 0, high: 0 });
  const [calibration, setCalibration] = useState<CalibrationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [band, setBand] = useState<BandFilter>('all');
  const [query, setQuery] = useState('');
  // Lo que se manda al servidor. Se separa de `query` para no disparar una
  // consulta por tecla: se confirma con Enter o con el botón.
  const [appliedQuery, setAppliedQuery] = useState('');
  // Rango de fechas de solicitud. Vacío = sin recorte para los instantáneos y
  // los solicitados; el historial cae a su ventana por defecto.
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [truncado, setTruncado] = useState({ instant: false, resolved: false });

  useEffect(() => {
    if (user === null) return;
    if (!hasRiskAccess) router.replace('/');
  }, [user, hasRiskAccess, router]);
  const accessDenied = user !== null && !hasRiskAccess;

  const fetchQueue = useCallback(
    (bandFilter: BandFilter, q: string, from = '', to = '') => {
      let alive = true;
      setLoading(true);
      loadQueue({
        band: bandFilter === 'all' ? null : bandFilter,
        q: q || null,
        from: from || null,
        to: to || null,
      })
        .then((res) => {
          if (!alive) return;
          setItems(res.items ?? []);
          setInstant(res.instant ?? []);
          setResolved(res.resolved ?? []);
          setCounts(res.counts ?? { low: 0, medium: 0, high: 0 });
          setCalibration(res.calibration ?? null);
          setTruncado(res.truncated ?? { instant: false, resolved: false });
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
    return fetchQueue(band, appliedQuery, desde, hasta);
  }, [band, appliedQuery, desde, hasta, accessDenied, fetchQueue]);

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

  // ── Paginado ──────────────────────────────────────────────────────────────
  // El filtro de texto de la cola pendiente va al SERVIDOR (ver api.ts), así
  // que acá el hook sólo pagina: por eso su `searchable` devuelve vacío. Los
  // resueltos sí se buscan en memoria — son la ventana de los últimos días, ya
  // vienen enteros y no hace falta un viaje por tecla.
  const cola = useTablePage<QueueItem>(items, () => '');
  const instantaneos = useTablePage<QueueItem>(instant, () => '');
  const cerrados = useTablePage<ResolvedItem>(
    resolved,
    (r) => `${r.username ?? ''} ${r.email ?? ''} ${r.externalId} ${r.statusRaw ?? ''}`,
  );

  const pagerLabels = {
    prev: t('table.prev'),
    next: t('table.next'),
    range: t('table.range'),
    filtered: t('table.filtered'),
  };

  // Aprobar y rechazar es de finanzas. Soporte triajea y escala desde la ficha;
  // no se le muestran botones que el servidor le va a rechazar igual.
  const puedeDecidir = roleCanApproveWithdrawal(user?.effective_role ?? '');

  const decidir = async (decision: QuickDecision, notes: string) => {
    if (!target) return;
    try {
      await saveDecision(target.externalId, { decision, notes: notes || null });
      toast.success(t('wdReview.quickSaved'));
      // Se recarga en vez de tocar la fila en memoria: la decisión puede sacar
      // el retiro de la cola, y dejarlo pintado sería mostrar algo que ya no es.
      fetchQueue(band, appliedQuery, desde, hasta);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('wdReview.quickError'));
      // Se relanza para que el diálogo no se cierre y no se pierda el motivo.
      throw err;
    }
  };

  // ── UNA sola definición de columnas para las DOS colas ──────────────────
  // Solicitados e instantáneos muestran exactamente lo mismo: cliente, monto,
  // método, score y factor. Copiar el bloque daría dos tablas que hoy se ven
  // iguales y en tres meses no, sin que nadie lo note hasta compararlas.
  const columnasCola: Column<QueueItem>[] = [
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
                  accessor: (i) => {
                    const quien = i.withdrawal.username ?? i.withdrawal.email ?? i.withdrawal.external_id;
                    const importe = money(
                      i.withdrawal.requested_amount ?? 0,
                      i.withdrawal.coin ?? undefined,
                    );
                    const abrir = (decision: QuickDecision) =>
                      setTarget({
                        externalId: i.withdrawal.external_id,
                        who: quien,
                        amount: importe,
                        decision,
                      });
                    return (
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          href={`/risk/retiros/${encodeURIComponent(i.withdrawal.external_id)}`}
                          className="inline-flex items-center gap-1 rounded-md p-1.5 text-xs text-primary hover:bg-muted"
                          aria-label={t('wdReview.review')}
                          title={t('wdReview.review')}
                        >
                          <Eye className="h-4 w-4" aria-hidden />
                        </Link>
                        {puedeDecidir && (
                          <>
                            <button
                              type="button"
                              onClick={() => abrir('approve')}
                              aria-label={t('wdReview.quickApprove')}
                              title={t('wdReview.quickApprove')}
                              className="rounded-md p-1.5 text-positive hover:bg-positive/10"
                            >
                              <Check className="h-4 w-4" aria-hidden />
                            </button>
                            <button
                              type="button"
                              onClick={() => abrir('reject')}
                              aria-label={t('wdReview.quickReject')}
                              title={t('wdReview.quickReject')}
                              className="rounded-md p-1.5 text-negative hover:bg-negative/10"
                            >
                              <X className="h-4 w-4" aria-hidden />
                            </button>
                          </>
                        )}
                      </div>
                    );
                  },
                },
                ];

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

            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">{t('wdReview.dateFrom')}</span>
                <input
                  type="date"
                  value={desde}
                  max={hasta || undefined}
                  onChange={(e) => setDesde(e.target.value)}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">{t('wdReview.dateTo')}</span>
                <input
                  type="date"
                  value={hasta}
                  min={desde || undefined}
                  onChange={(e) => setHasta(e.target.value)}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm"
                />
              </label>
              {(desde || hasta) && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setDesde(''); setHasta(''); }}
                >
                  {t('wdReview.dateClear')}
                </Button>
              )}
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

          <SectionTabs
            value={seccion}
            onChange={setSeccion}
            label={t('wdReview.sectionsLabel')}
            tabs={[
              { value: 'solicitados', label: t('wdReview.tabRequested'), count: items.length },
              { value: 'instant', label: t('wdReview.tabInstant'), count: instant.length },
              { value: 'historial', label: t('wdReview.tabHistory'), count: resolved.length },
            ]}
          />

          {seccion === 'solicitados' && (
          <Card className="p-0 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
              <p className="text-xs text-muted-foreground">{t('wdReview.requestedHint')}</p>
              <TableCsvButton<QueueItem>
                rows={cola.filtered}
                filename="Retiros_solicitados"
                label={t('table.csv')}
                headers={[
                  t('wdReview.colClient'), 'email', t('wdReview.colAmount'), t('wdReview.colMethod'),
                  t('wdReview.colRequested'), t('wdReview.colScore'), t('wdReview.colMainFactor'),
                  t('wdReview.colDecision'),
                ]}
                toRow={(i) => [
                  i.withdrawal.username ?? '', i.withdrawal.email ?? '',
                  i.withdrawal.requested_amount ?? 0, i.paymentMethod,
                  i.withdrawal.requested_at ?? '',
                  `${i.score.approvalScore} (${t(`wdReview.band.${i.score.band}`)})`,
                  i.score.factors.find((f) => f.impact === 'down')?.label ?? '',
                  i.review?.decision ? t(`wdReview.decision.${i.review.decision}`) : '',
                ]}
              />
            </div>
            <DataTable
              stickyHeader
              zebra
              data={cola.pageRows}
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
              columns={columnasCola}
            />
            <TablePager
              page={cola.page}
              pageCount={cola.pageCount}
              shown={cola.pageRows.length}
              total={cola.total}
              filteredTotal={cola.filtered.length}
              onPage={cola.setPage}
              labels={pagerLabels}
            />
          </Card>
          )}

          {/* ── Instantáneos ─────────────────────────────────────────────────
              Los aprueba el sistema solo: cuando alguien los mira, el dinero ya
              salió. No hay nada que decidir — lo que hay que ver es qué tan
              arriesgado era lo que se fue, que es justo lo que nadie miraba.
              Por eso tienen score igual que la cola, y por eso van APARTE:
              mezclados, una lista de trabajo se vuelve una lista de lectura. */}
          {seccion === 'instant' && (
          <Card className="p-0 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
              <div className="text-xs text-muted-foreground">
                <p>{t('wdReview.instantHint')}</p>
                {/* Un recorte silencioso es indistinguible de "no hay más":
                    la tabla mostraría el tope con cara de ser la lista entera. */}
                {truncado.instant && (
                  <p className="mt-1 font-medium text-warning">{t('wdReview.truncated')}</p>
                )}
              </div>
              <TableCsvButton<QueueItem>
                rows={instantaneos.filtered}
                filename="Retiros_instantaneos"
                label={t('table.csv')}
                headers={[
                  t('wdReview.colClient'), 'email', t('wdReview.colAmount'), t('wdReview.colMethod'),
                  t('wdReview.colRequested'), t('wdReview.colScore'), t('wdReview.colMainFactor'),
                  t('wdReview.colDecision'),
                ]}
                toRow={(i) => [
                  i.withdrawal.username ?? '', i.withdrawal.email ?? '',
                  i.withdrawal.requested_amount ?? 0, i.paymentMethod,
                  i.withdrawal.requested_at ?? '',
                  `${i.score.approvalScore} (${t(`wdReview.band.${i.score.band}`)})`,
                  i.score.factors.find((f) => f.impact === 'down')?.label ?? '',
                  i.review?.decision ? t(`wdReview.decision.${i.review.decision}`) : '',
                ]}
              />
            </div>
            <DataTable
              stickyHeader
              zebra
              data={instantaneos.pageRows}
              empty={
                <EmptyState
                  compact
                  icon={Zap}
                  title={t('wdReview.instantEmpty')}
                  description={t('wdReview.instantEmptyHint')}
                />
              }
              columns={columnasCola}
            />
            <TablePager
              page={instantaneos.page}
              pageCount={instantaneos.pageCount}
              shown={instantaneos.pageRows.length}
              total={instantaneos.total}
              filteredTotal={instantaneos.filtered.length}
              onPage={instantaneos.setPage}
              labels={pagerLabels}
            />
          </Card>
          )}

          {/* ── Los que ya cambiaron de estado ──────────────────────────────
              Un retiro no desaparece cuando alguien lo toca: pasa a COMPLETED,
              FAILED o REJECTED, y puede recorrer estados intermedios antes.
              Sin esta sección la fila simplemente se esfumaba de la cola y no
              había forma de saber en qué terminó — ni de contrastar lo que
              nosotros habíamos decidido con lo que el CRM hizo. */}
          {seccion === 'historial' && (
          <Card className="p-0 overflow-hidden">
            <div className="px-4 pt-4">
              <CardTitle>{t('wdReview.resolvedTitle')}</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('wdReview.resolvedHint')}
              </p>
              {truncado.resolved && (
                <p className="mt-1 mb-3 text-xs font-medium text-warning">
                  {t('wdReview.truncated')}
                </p>
              )}
              <div className="mb-3" />
              <div className="mb-3">
                <TableSearch
                  value={cerrados.query}
                  onChange={cerrados.setQuery}
                  placeholder={t('wdReview.resolvedSearch')}
                />
              </div>
            </div>
            <DataTable<ResolvedItem>
              zebra
              density="compact"
              data={cerrados.pageRows}
              empty={
                <EmptyState
                  compact
                  icon={History}
                  title={t('wdReview.resolvedEmpty')}
                  description={t('wdReview.resolvedEmptyHint')}
                />
              }
              columns={[
                {
                  header: t('wdReview.colClient'),
                  accessor: (r) => (
                    <div className="min-w-0">
                      <p className="truncate font-medium">{r.username ?? t('wdReview.noUser')}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {r.email ?? r.externalId}
                      </p>
                    </div>
                  ),
                },
                {
                  header: t('wdReview.colAmount'),
                  align: 'right',
                  accessor: (r) => (
                    <span className="font-semibold tabular-nums">{money(r.amount ?? 0)}</span>
                  ),
                },
                {
                  header: t('wdReview.colFinalStatus'),
                  accessor: (r) => (
                    <div className="flex items-center gap-2">
                      {/* El estado CRUDO del CRM, no una traducción nuestra:
                          entre REQUESTED y COMPLETED hay estados intermedios y
                          normalizarlos escondería en cuál está parado. */}
                      <Badge variant={STATUS_VARIANT(r.statusNorm)}>
                        {r.statusRaw ?? r.statusNorm}
                      </Badge>
                      {r.wasInstant && (
                        <span className="text-xs text-muted-foreground">
                          {t('wdReview.wasInstant')}
                        </span>
                      )}
                    </div>
                  ),
                },
                {
                  header: t('wdReview.colProcessed'),
                  accessor: (r) => (
                    <span className="text-xs">
                      {r.processedAt ? formatDateTime(r.processedAt) : '—'}
                    </span>
                  ),
                },
                {
                  header: t('wdReview.colOurDecision'),
                  accessor: (r) =>
                    r.ourDecision ? (
                      <div>
                        <Badge variant={r.ourDecision === 'approve' ? 'success' : 'neutral'}>
                          {t(`wdReview.decision.${r.ourDecision}`)}
                        </Badge>
                        {r.ourDecidedBy && (
                          <p className="mt-0.5 text-xs text-muted-foreground">{r.ourDecidedBy}</p>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t('wdReview.neverReviewed')}
                      </span>
                    ),
                },
                {
                  header: '',
                  align: 'right',
                  accessor: (r) => (
                    <Link
                      href={`/risk/retiros/${encodeURIComponent(r.externalId)}`}
                      className="inline-flex items-center gap-1 rounded-md p-1.5 text-xs text-primary hover:bg-muted"
                      aria-label={t('wdReview.review')}
                      title={t('wdReview.review')}
                    >
                      <Eye className="h-4 w-4" aria-hidden />
                    </Link>
                  ),
                },
              ]}
            />
            <TablePager
              page={cerrados.page}
              pageCount={cerrados.pageCount}
              shown={cerrados.pageRows.length}
              total={cerrados.total}
              filteredTotal={cerrados.filtered.length}
              onPage={cerrados.setPage}
              labels={pagerLabels}
            />
          </Card>
          )}

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

      {target && (
        <QuickDecisionDialog
          target={target}
          onClose={() => setTarget(null)}
          onConfirm={decidir}
          labels={{
            approveTitle: t('wdReview.quickApproveTitle'),
            rejectTitle: t('wdReview.quickRejectTitle'),
            reason: t('wdReview.quickReason'),
            reasonRequired: t('wdReview.quickReasonRequired'),
            reasonOptional: t('wdReview.quickReasonOptional'),
            notExecuted: t('wdReview.quickNotExecuted'),
            confirmApprove: t('wdReview.quickConfirmApprove'),
            confirmReject: t('wdReview.quickConfirmReject'),
            cancel: t('wdReview.quickCancel'),
          }}
        />
      )}
    </div>
  );
}
