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
//
// ── «LIBRO MAYOR» (2026-10-12) ──────────────────────────────────────────────
// Sólo presentación: el score, sus bandas, los filtros que van al server y el
// flujo de decisión (finanzas aprueba/rechaza, soporte escala desde la ficha)
// no cambiaron. Lo que sí:
//   · KpiStrip en vez de tres StatCard con ícono de color. El monto `null` de
//     un retiro ya no se suma como 0 (antes `requested_amount ?? 0`): el KPI
//     suma los conocidos y dice cuántos no tienen monto (queue-view.ts).
//   · Secciones con Segmented: los solicitados se parten en Pendientes y
//     Escalados (última decisión = escalate; esperan a finanzas). Antes un
//     escalado se mezclaba con los no tocados y sólo se distinguía leyendo la
//     columna Decisión. Los dos conteos suman los solicitados.
//   · Chips de banda (filtro al server, conteos del server) y de método (en
//     memoria sobre la sección, con los métodos que HAY — ver queue-view.ts).
//   · FinTable densa (36 px): cliente con email como meta, monto con <Money>
//     (null → «—», no $0.00), método con la wallet de destino en mono y con
//     copia (antes no se veía), score con badge de banda desde risk-kinds.ts
//     (bajo=ok, medio=pend, alto=bad), antigüedad en `pend` si ≥ 7 d.
//   · Acciones de fila al hover; aprobar/rechazar sólo para quien puede
//     decidir (roleCanApproveWithdrawal), como antes.
//   · El estado final del Historial ahora pinta COMPLETED en verde: el mapa
//     viejo preguntaba por `completed`, que no existe en status_norm de
//     retiros (es `approved`), y lo dejaba gris como un cancelado.
//
// DESCARTADO:
//   · Paginar dentro de FinTable: la tabla no pagina a propósito (esconde
//     cuántas filas hay). Se sigue usando useTablePage + TablePager, que dicen
//     «N–M de T».
//   · Sacar «Instantáneos» del Segmented para dejar sólo las tres secciones
//     del pedido: son retiros que ya salieron y que nadie más mira; quitarlos
//     escondería una lista entera.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ShieldAlert, Search, Eye, Check, X, History, Zap } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { Chip } from '@/components/ui/chip';
import { Field, Input } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useToasts } from '@/components/ui/toast';
import { useTablePage, TableSearch, TablePager, TableCsvButton } from '@/components/ui/table-toolbar';
import { ActionButton, ROW_ACTION_CLASS } from '@/components/payment-orders/action-button';
import {
  QuickDecisionDialog,
  type QuickDecisionTarget,
  type QuickDecision,
} from '@/components/withdrawal/quick-decision-dialog';
import { WalletAddress } from '@/components/risk/wallet-address';
import { bandKind, decisionKind, withdrawalStatusKind } from '@/components/risk/risk-kinds';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { useData } from '@/lib/data-context';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/money';
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
import {
  displayCurrency,
  filterQueueRows,
  isStale,
  methodCounts,
  queueKpis,
  sectionCounts,
  type AmountTotal,
} from './queue-view';

type BandFilter = 'all' | RiskBand;
type Seccion = 'pending' | 'escalated' | 'instant' | 'history';

// Aprobar / rechazar en la fila: el hover dice qué hace el botón con el color
// que significa eso (pos / neg). Se arma reemplazando el hover de la receta
// común porque `cn` no fusiona clases (dos `hover:text-*` pelearían).
const ROW_APPROVE_CLASS = ROW_ACTION_CLASS.replace('hover:text-foreground', 'hover:text-pos');
const ROW_REJECT_CLASS = ROW_ACTION_CLASS.replace('hover:text-foreground', 'hover:text-neg');

const BAND_FILTERS: { value: BandFilter; key: string }[] = [
  { value: 'all', key: 'wdReview.filterAll' },
  { value: 'high', key: 'wdReview.filterHigh' },
  { value: 'medium', key: 'wdReview.filterMedium' },
  { value: 'low', key: 'wdReview.filterLow' },
];

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
  const [seccion, setSeccion] = useState<Seccion>('pending');
  // El retiro sobre el que está abierto el diálogo de decisión rápida.
  const [target, setTarget] = useState<QuickDecisionTarget | null>(null);
  const [counts, setCounts] = useState<Record<RiskBand, number>>({ low: 0, medium: 0, high: 0 });
  const [calibration, setCalibration] = useState<CalibrationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [band, setBand] = useState<BandFilter>('all');
  // Método: filtro en memoria sobre la sección (los métodos que hay en ella).
  const [method, setMethod] = useState<string | null>(null);
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
    // Sin acceso NO se consulta, pero hay que apagar el spinner igual: si una
    // carga ya arrancó y este efecto vuelve a correr saliendo por acá, el
    // `finally` de la petición anterior ya no toca el estado (su `alive` quedó
    // en false) y la pantalla se queda en esqueletos para siempre.
    if (accessDenied) {
      setLoading(false);
      return;
    }
    return fetchQueue(band, appliedQuery, desde, hasta);
  }, [band, appliedQuery, desde, hasta, accessDenied, fetchQueue]);

  const companyCurrency = company?.currency || 'USD';
  const currencyOf = (coin: string | null | undefined) => displayCurrency(coin, companyCurrency);
  const moneyText = (n: number | null | undefined, coin?: string | null) =>
    typeof n === 'number' && Number.isFinite(n) ? formatMoney(n, { currency: currencyOf(coin) }) : '—';

  // ── KPIs y secciones ──────────────────────────────────────────────────────
  const kpis = useMemo(() => queueKpis(items), [items]);
  const secCounts = useMemo(() => sectionCounts(items), [items]);

  // La lista de la sección, antes del chip de método (de acá salen sus chips).
  const sectionRows = useMemo<QueueItem[]>(() => {
    if (seccion === 'instant') return instant;
    if (seccion === 'pending' || seccion === 'escalated') {
      return filterQueueRows(items, { section: seccion, method: null });
    }
    return [];
  }, [seccion, items, instant]);
  const methods = useMemo(() => methodCounts(sectionRows), [sectionRows]);
  // Si el método elegido no existe en la sección (cambió la sección o la
  // carga), se ignora en vez de dejar una tabla vacía sin chip activo visible.
  const activeMethod = method && methods.some((m) => m.method === method) ? method : null;
  const queueRows = useMemo(
    () => filterQueueRows(sectionRows, { section: null, method: activeMethod }),
    [sectionRows, activeMethod],
  );

  // ── Paginado ──────────────────────────────────────────────────────────────
  // El filtro de texto de la cola pendiente va al SERVIDOR (ver api.ts), así
  // que acá el hook sólo pagina: por eso su `searchable` devuelve vacío. Los
  // resueltos sí se buscan en memoria — son la ventana de los últimos días, ya
  // vienen enteros y no hace falta un viaje por tecla.
  const cola = useTablePage<QueueItem>(queueRows, () => '');
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

  const detailHref = (externalId: string) => `/risk/retiros/${encodeURIComponent(externalId)}`;

  // ── UNA sola definición de columnas para las colas ────────────────────────
  // Pendientes, escalados e instantáneos muestran exactamente lo mismo.
  // Copiar el bloque daría tablas que hoy se ven iguales y en tres meses no,
  // sin que nadie lo note hasta compararlas.
  const columnasCola: FinColumn<QueueItem>[] = [
    {
      key: 'client',
      header: t('wdReview.colClient'),
      cell: (i) => i.withdrawal.username ?? t('wdReview.noUser'),
      meta: (i) => i.withdrawal.email ?? i.withdrawal.external_id,
      mobileMeta: (i) => (
        <>
          <StatusBadge kind={bandKind(i.score.band)} label={t(`wdReview.band.${i.score.band}`)} />
          <AgeText days={i.ageDays} />
        </>
      ),
    },
    {
      key: 'amount',
      header: t('wdReview.colAmount'),
      kind: 'money',
      value: (i) => i.withdrawal.requested_amount,
      cell: (i) => (
        <Money
          value={i.withdrawal.requested_amount}
          currency={currencyOf(i.withdrawal.coin)}
          nullLabel={t('ui.noData')}
          className="font-medium"
        />
      ),
    },
    {
      key: 'method',
      header: t('riskLm.colMethodWallet'),
      hideSm: true,
      cell: (i) => (
        <div className="min-w-0 py-1.5">
          <div className="truncate text-[13px] text-foreground">{i.paymentMethod || '—'}</div>
          <WalletAddress address={i.withdrawal.target_address} />
        </div>
      ),
    },
    {
      key: 'score',
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
      key: 'factor',
      header: t('wdReview.colMainFactor'),
      hideSm: true,
      cell: (i) => {
        const worst = i.score.factors.find((f) => f.impact === 'down');
        return (
          <span className="block max-w-[220px] truncate text-[12.5px] text-text-2" title={worst?.detail}>
            {worst ? worst.label : t('wdReview.noRedFlags')}
          </span>
        );
      },
    },
    {
      key: 'decision',
      header: t('wdReview.colDecision'),
      hideSm: true,
      cell: (i) =>
        i.review?.decision ? (
          <StatusBadge kind={decisionKind(i.review.decision)} label={t(`wdReview.decision.${i.review.decision}`)} />
        ) : (
          <span className="text-[12.5px] text-text-3">{t('wdReview.undecided')}</span>
        ),
    },
    {
      key: 'age',
      header: t('riskLm.colAge'),
      align: 'right',
      hideSm: true,
      cell: (i) => (
        <div className="py-1.5 text-right">
          <AgeText days={i.ageDays} />
          <div className={cn(NUM_CLASS, 'text-[12px] text-text-3')}>{formatDateTime(i.withdrawal.requested_at)}</div>
        </div>
      ),
    },
  ];

  const accionesCola = (i: QueueItem) => {
    const quien = i.withdrawal.username ?? i.withdrawal.email ?? i.withdrawal.external_id;
    const importe = moneyText(i.withdrawal.requested_amount, i.withdrawal.coin);
    const abrir = (decision: QuickDecision) =>
      setTarget({ externalId: i.withdrawal.external_id, who: quien, amount: importe, decision });
    return (
      <>
        <Link
          href={detailHref(i.withdrawal.external_id)}
          className={ROW_ACTION_CLASS}
          aria-label={t('wdReview.review')}
          title={t('wdReview.review')}
        >
          <Eye className="size-4" aria-hidden />
        </Link>
        {/* Los instantáneos ya salieron: no hay nada que decidir sobre ellos. */}
        {puedeDecidir && seccion !== 'instant' && (
          <>
            <button
              type="button"
              onClick={() => abrir('approve')}
              aria-label={t('wdReview.quickApprove')}
              title={t('wdReview.quickApprove')}
              className={ROW_APPROVE_CLASS}
            >
              <Check className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => abrir('reject')}
              aria-label={t('wdReview.quickReject')}
              title={t('wdReview.quickReject')}
              className={ROW_REJECT_CLASS}
            >
              <X className="size-4" aria-hidden />
            </button>
          </>
        )}
      </>
    );
  };

  const columnasHistorial: FinColumn<ResolvedItem>[] = [
    {
      key: 'client',
      header: t('wdReview.colClient'),
      cell: (r) => r.username ?? t('wdReview.noUser'),
      meta: (r) => r.email ?? r.externalId,
      mobileMeta: (r) => (
        <StatusBadge kind={withdrawalStatusKind(r.statusNorm)} label={r.statusRaw ?? r.statusNorm} />
      ),
    },
    {
      key: 'amount',
      header: t('wdReview.colAmount'),
      kind: 'money',
      value: (r) => r.amount,
      money: { currency: companyCurrency },
    },
    {
      key: 'score',
      header: t('wdReview.colScore'),
      hideSm: true,
      cell: (r) =>
        r.score !== null && r.scoreBand !== null ? (
          <span className="inline-flex items-center gap-2">
            <span className={cn(NUM_CLASS, 'w-7 text-right font-semibold')}>{r.score}</span>
            <StatusBadge kind={bandKind(r.scoreBand)} label={t(`wdReview.band.${r.scoreBand}`)} />
          </span>
        ) : (
          // null = nunca pasó por revisión acá; no es un score 0.
          <span className="text-[12.5px] text-text-3">{t('wdReview.noScore')}</span>
        ),
    },
    {
      key: 'status',
      header: t('wdReview.colFinalStatus'),
      hideSm: true,
      // El estado CRUDO del CRM, no una traducción nuestra: entre REQUESTED y
      // COMPLETED hay estados intermedios y normalizarlos escondería en cuál
      // está parado. El COLOR sí sale del normalizado (risk-kinds.ts).
      cell: (r) => (
        <span className="inline-flex items-center gap-2">
          <StatusBadge kind={withdrawalStatusKind(r.statusNorm)} label={r.statusRaw ?? r.statusNorm} />
          {r.wasInstant && <span className="text-[12px] text-text-3">{t('wdReview.wasInstant')}</span>}
        </span>
      ),
    },
    {
      key: 'processed',
      header: t('wdReview.colProcessed'),
      hideSm: true,
      cell: (r) => (
        <span className={cn(NUM_CLASS, 'text-[12.5px] text-text-2')}>
          {r.processedAt ? formatDateTime(r.processedAt) : '—'}
        </span>
      ),
    },
    {
      key: 'ours',
      header: t('wdReview.colOurDecision'),
      hideSm: true,
      cell: (r) =>
        r.ourDecision ? (
          <div className="py-1.5">
            <StatusBadge kind={decisionKind(r.ourDecision)} label={t(`wdReview.decision.${r.ourDecision}`)} />
            {r.ourDecidedBy && <div className="mt-0.5 text-[12px] text-text-3">{r.ourDecidedBy}</div>}
          </div>
        ) : (
          <span className="text-[12.5px] text-text-3">{t('wdReview.neverReviewed')}</span>
        ),
    },
  ];

  if (accessDenied) return null;

  const hasFilters = band !== 'all' || appliedQuery !== '' || activeMethod !== null;
  const allCount = counts.low + counts.medium + counts.high;
  const isQueue = seccion !== 'history';

  const kpiSub = (a: AmountTotal, text: string) => (
    <>
      {text}
      {a.missing > 0 && ` · ${t('riskLm.missingAmount', { n: String(a.missing) })}`}
    </>
  );
  const kpiItems: KpiItem[] = [
    {
      key: 'pending',
      label: t('wdReview.kpiPending'),
      value: kpis.total.sum,
      currency: companyCurrency,
      hero: true,
      sub: kpiSub(kpis.total, t('wdReview.kpiPendingHint', { count: String(kpis.total.count) })),
      // Sin solicitudes no hay nada que sumar: es «—» con la explicación, no
      // un $0.00 que se lee como dato.
      missingBadge: false,
    },
    {
      key: 'high',
      label: t('wdReview.kpiHigh'),
      value: kpis.high.count,
      format: 'count',
      sub: kpiSub(kpis.high, t('wdReview.kpiHighHint', { amount: moneyText(kpis.high.sum) })),
    },
    {
      key: 'stale',
      label: t('wdReview.kpiStale'),
      value: kpis.stale.count,
      format: 'count',
      sub: kpiSub(kpis.stale, t('wdReview.kpiStaleHint', { amount: moneyText(kpis.stale.sum) })),
    },
    {
      key: 'escalated',
      label: t('riskLm.kpiEscalated'),
      value: secCounts.escalated,
      format: 'count',
      sub: t('riskLm.kpiEscalatedHint'),
    },
  ];

  const csvHeaders = [
    t('wdReview.colClient'), 'email', t('wdReview.colAmount'), t('wdReview.colMethod'), 'wallet',
    t('wdReview.colRequested'), t('wdReview.colScore'), t('wdReview.colMainFactor'), t('wdReview.colDecision'),
  ];
  const csvRow = (i: QueueItem) => [
    i.withdrawal.username ?? '', i.withdrawal.email ?? '',
    // Un CSV se abre sin contexto: el hueco va vacío, NUNCA como 0.
    i.withdrawal.requested_amount ?? '', i.paymentMethod, i.withdrawal.target_address ?? '',
    i.withdrawal.requested_at ?? '',
    `${i.score.approvalScore} (${t(`wdReview.band.${i.score.band}`)})`,
    i.score.factors.find((f) => f.impact === 'down')?.label ?? '',
    i.review?.decision ? t(`wdReview.decision.${i.review.decision}`) : '',
  ];

  const sectionMeta: Record<Exclude<Seccion, 'history'>, { title: string; hint: string; csv: string }> = {
    pending: { title: t('riskLm.secPending'), hint: t('wdReview.requestedHint'), csv: 'Retiros_pendientes' },
    escalated: { title: t('riskLm.secEscalated'), hint: t('riskLm.escalatedHint'), csv: 'Retiros_escalados' },
    instant: { title: t('wdReview.tabInstant'), hint: t('wdReview.instantHint'), csv: 'Retiros_instantaneos' },
  };

  const queueEmpty =
    seccion === 'instant' ? (
      <EmptyState compact icon={Zap} title={t('wdReview.instantEmpty')} description={t('wdReview.instantEmptyHint')} />
    ) : seccion === 'escalated' && !hasFilters ? (
      <EmptyState
        compact
        icon={ShieldAlert}
        title={t('riskLm.emptyEscalated')}
        description={t('riskLm.emptyEscalatedHint')}
      />
    ) : (
      <EmptyState
        compact
        icon={ShieldAlert}
        title={hasFilters ? t('wdReview.emptyFiltered') : t('wdReview.emptyNone')}
        description={hasFilters ? t('wdReview.emptyFilteredHint') : t('wdReview.emptyNoneHint')}
      />
    );

  return (
    <div className="space-y-4">
      {ToastHost}

      <PageHeader icon={ShieldAlert} title={t('wdReview.title')} subtitle={t('wdReview.subtitle')} />

      {/* El aviso es parte del control, no decoración: quien use la pantalla
          tiene que saber que registrar una decisión no mueve el dinero. */}
      <Notice kind="info" title={t('riskLm.disclaimerTitle')}>
        {t('wdReview.disclaimer')}
      </Notice>

      {loading && items.length === 0 && instant.length === 0 && resolved.length === 0 ? (
        <div className="space-y-4">
          <Skeleton className="h-[92px]" />
          <Skeleton className="h-10 w-full max-w-md" />
          <Skeleton className="h-80" />
        </div>
      ) : (
        <>
          <KpiStrip items={kpiItems} />

          {/* ── Secciones y filtros ──────────────────────────────────────── */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <Segmented<Seccion>
                aria-label={t('wdReview.sectionsLabel')}
                value={seccion}
                onChange={(v) => {
                  setSeccion(v);
                  setMethod(null);
                }}
                className="max-w-full overflow-x-auto"
                options={[
                  { value: 'pending', label: t('riskLm.secPending'), count: secCounts.pending },
                  { value: 'escalated', label: t('riskLm.secEscalated'), count: secCounts.escalated },
                  { value: 'instant', label: t('wdReview.tabInstant'), count: instant.length },
                  { value: 'history', label: t('wdReview.tabHistory'), count: resolved.length },
                ]}
              />

              <div className="flex flex-wrap items-end gap-2">
                <Field label={t('wdReview.dateFrom')}>
                  <Input
                    type="date"
                    value={desde}
                    max={hasta || undefined}
                    onChange={(e) => setDesde(e.target.value)}
                    className="w-[150px]"
                  />
                </Field>
                <Field label={t('wdReview.dateTo')}>
                  <Input
                    type="date"
                    value={hasta}
                    min={desde || undefined}
                    onChange={(e) => setHasta(e.target.value)}
                    className="w-[150px]"
                  />
                </Field>
                {(desde || hasta) && (
                  <ActionButton
                    variant="ghost"
                    onClick={() => {
                      setDesde('');
                      setHasta('');
                    }}
                  >
                    {t('wdReview.dateClear')}
                  </ActionButton>
                )}
                <form
                  className="relative w-full sm:w-[260px]"
                  role="search"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setAppliedQuery(query.trim());
                  }}
                >
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3"
                    aria-hidden
                  />
                  <Input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('wdReview.searchPlaceholder')}
                    aria-label={t('wdReview.searchPlaceholder')}
                    className="pl-8"
                  />
                </form>
              </div>
            </div>

            {isQueue && (
              <div className="flex flex-col gap-2">
                <div role="group" aria-label={t('riskLm.bandFilterLabel')} className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-medium text-text-3">{t('riskLm.bandFilterLabel')}</span>
                  {BAND_FILTERS.map((f) => (
                    <Chip
                      key={f.value}
                      active={band === f.value}
                      onClick={() => setBand(f.value)}
                      count={f.value === 'all' ? allCount : counts[f.value]}
                    >
                      {t(f.key)}
                    </Chip>
                  ))}
                </div>
                {methods.length > 1 && (
                  <div
                    role="group"
                    aria-label={t('riskLm.methodFilterLabel')}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span className="text-[12px] font-medium text-text-3">{t('riskLm.methodFilterLabel')}</span>
                    <Chip active={activeMethod === null} onClick={() => setMethod(null)} count={sectionRows.length}>
                      {t('wdReview.filterAll')}
                    </Chip>
                    {methods.map((m) => (
                      <Chip
                        key={m.method}
                        active={activeMethod === m.method}
                        onClick={() => setMethod(activeMethod === m.method ? null : m.method)}
                        count={m.count}
                      >
                        {m.method}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Colas: pendientes / escalados / instantáneos ────────────────
              Los instantáneos los aprueba el sistema solo: cuando alguien los
              mira, el dinero ya salió. No hay nada que decidir — lo que hay
              que ver es qué tan arriesgado era lo que se fue. Por eso tienen
              score igual que la cola, y por eso van APARTE. */}
          {seccion !== 'history' && (
            <Panel
              title={sectionMeta[seccion].title}
              hint={sectionMeta[seccion].hint}
              flush
              actions={
                <TableCsvButton<QueueItem>
                  rows={cola.filtered}
                  filename={sectionMeta[seccion].csv}
                  label={t('table.csv')}
                  headers={csvHeaders}
                  toRow={csvRow}
                />
              }
            >
              {/* Un recorte silencioso es indistinguible de "no hay más": la
                  tabla mostraría el tope con cara de ser la lista entera. */}
              {seccion === 'instant' && truncado.instant && (
                <div className="px-4 pt-3">
                  <Notice kind="pend" title={t('riskLm.truncatedTitle')}>
                    {t('wdReview.truncated')}
                  </Notice>
                </div>
              )}
              <FinTable<QueueItem>
                caption={sectionMeta[seccion].title}
                columns={columnasCola}
                rows={cola.pageRows}
                rowKey={(i) => i.withdrawal.external_id}
                onRowClick={(i) => router.push(detailHref(i.withdrawal.external_id))}
                rowActions={accionesCola}
                empty={queueEmpty}
                maxHeight="70vh"
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
            </Panel>
          )}

          {/* ── Los que ya cambiaron de estado ──────────────────────────────
              Un retiro no desaparece cuando alguien lo toca: pasa a COMPLETED,
              FAILED o REJECTED, y puede recorrer estados intermedios antes.
              Sin esta sección la fila simplemente se esfumaba de la cola y no
              había forma de saber en qué terminó — ni de contrastar lo que
              nosotros habíamos decidido con lo que el CRM hizo. */}
          {seccion === 'history' && (
            <Panel
              title={t('wdReview.resolvedTitle')}
              hint={t('wdReview.resolvedHint')}
              flush
              actions={
                <TableSearch
                  value={cerrados.query}
                  onChange={cerrados.setQuery}
                  placeholder={t('wdReview.resolvedSearch')}
                />
              }
            >
              {truncado.resolved && (
                <div className="px-4 pt-3">
                  <Notice kind="pend" title={t('riskLm.truncatedTitle')}>
                    {t('wdReview.truncated')}
                  </Notice>
                </div>
              )}
              <FinTable<ResolvedItem>
                caption={t('wdReview.resolvedTitle')}
                columns={columnasHistorial}
                rows={cerrados.pageRows}
                rowKey={(r) => r.externalId}
                onRowClick={(r) => router.push(detailHref(r.externalId))}
                rowActions={(r) => (
                  <Link
                    href={detailHref(r.externalId)}
                    className={ROW_ACTION_CLASS}
                    aria-label={t('wdReview.review')}
                    title={t('wdReview.review')}
                  >
                    <Eye className="size-4" aria-hidden />
                  </Link>
                )}
                empty={
                  <EmptyState
                    compact
                    icon={History}
                    title={t('wdReview.resolvedEmpty')}
                    description={t('wdReview.resolvedEmptyHint')}
                  />
                }
                maxHeight="70vh"
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
            </Panel>
          )}

          {calibration && (
            <p className="text-[12.5px] text-text-3">
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

/** «12 d» en `pend` si lleva ≥ 7 días; null = sin fecha (no «0 d»). */
function AgeText({ days }: { days: number | null }) {
  const { t } = useI18n();
  if (days === null || !Number.isFinite(days)) {
    return <span className="text-[12px] text-text-3">{t('riskLm.ageUnknown')}</span>;
  }
  return (
    <span className={cn(NUM_CLASS, 'text-[12.5px]', isStale(days) ? 'font-medium text-pend' : 'text-text-2')}>
      {t('wdReview.ageDays', { days: String(Math.floor(days)) })}
    </span>
  );
}
