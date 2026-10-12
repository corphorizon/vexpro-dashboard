'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /risk/exposicion — el riesgo vivo del bróker.
//
// ── EL ALCANCE, QUE VALE PARA TODA LA PANTALLA ─────────────────────────────
// Sólo cuentas vinculadas al CRM (Kevin, 2026-08-26). En MetaTrader hay ~1.140
// cuentas reales más que en el CRM: son de prueba, abren posiciones y usan
// margen igual que un cliente, y nada en el dato de MT5 las delata. No entran
// a NINGUNA cifra de acá — ni al PNL, ni a la exposición, ni al margen.
//
// ── POR QUÉ SECCIONES Y NO UNA COLUMNA LARGA ───────────────────────────────
// Las preguntas que responde esta pantalla se hacen en momentos distintos:
// "¿me estoy quedando corto de margen?" es una urgencia y "¿cómo cerró la
// semana?" es una revisión. Apiladas, la urgente queda a tres scrolls de la
// primera pantalla.
//
// Los KPI quedan ARRIBA de las secciones a propósito: son el resumen que hay
// que ver siempre, sin importar qué sección esté abierta.
//
// ── LO QUE ESTA PANTALLA NO HACE ───────────────────────────────────────────
// No muestra un total de dinero sumando todo. Las cuentas Cent están EN
// CENTAVOS y las PropFirm llevan capital virtual de desafío: sumar sus
// flotantes daría cientos de miles de "dólares" que no existen. Cada importe
// va con su unidad al lado, en pantalla, en el CSV y en el PDF.
//
// El dato tiene hasta 15 minutos: se dice arriba, con la hora exacta. Una
// pantalla de riesgo que no diga de cuándo es su dato invita a decidir sobre
// algo viejo creyendo que es de ahora.
//
// ── «LIBRO MAYOR» (2026-10-12) ──────────────────────────────────────────────
// Sólo presentación; ninguna consulta ni cifra cambió.
//   · Frescura: badge «hace X min» junto a la hora exacta; con más de 30 min
//     pasa a `stale` y aparece un aviso (risk-format.ts → snapshotFreshness).
//     Antes la hora estaba escrita pero nada la marcaba vieja.
//   · KpiStrip con conteos (no hay KPI de dinero: ver arriba).
//   · Todas las tablas con FinTable; los importes con <UnitAmount> (cifra +
//     unidad). P&L y flotante con tono `sign`; equity y margen sólo pintan
//     negativos — antes TODO positivo iba en verde, también el margen usado.
//   · Lotes netos sin color: el signo dice de qué lado está el cliente, no si
//     es bueno o malo (spec §2.1). Antes verde/rojo.
//   · Concentración con la columna de participación (% + barra 64×6), no con
//     <DistributionBar>: ver exposure-view.ts.
//   · El badge de nivel de margen sale de la LISTA del server (crítico /
//     vigilancia), no de `(margin_level ?? 0) < 100` (un null era «0%» rojo).
//   · jsPDF con `await import()`: el módulo de PDF ya no viaja en el bundle de
//     la pantalla (antes import estático de `@/lib/pdf-export`).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, CalendarDays, FileText, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { NUM_CLASS } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { Notice } from '@/components/ui/notice';
import { Segmented } from '@/components/ui/segmented';
import { Field, Input } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useToasts } from '@/components/ui/toast';
import { useTablePage, TableSearch, TablePager, TableCsvButton } from '@/components/ui/table-toolbar';
import { ActionButton } from '@/components/ui/action-button';
import { UnitAmount } from '@/components/risk/unit-amount';
import { marginKind } from '@/components/risk/risk-kinds';
import { snapshotFreshness, unitOfCategory, SNAPSHOT_STALE_MIN } from '@/components/risk/risk-format';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { MONEY_LOCALE } from '@/lib/money';
import { cn, formatNumber } from '@/lib/utils';
import { formatDateTime } from '@/lib/dates';
import type { RiskSnapshot, ExposureRow, PnlRow, SymbolConcentration } from '@/lib/mt5-sync/risk-query';
import type { CrmDailyPnlRow } from '@/lib/crm-sync/daily-pnl-query';
import { marginLevelText, marginRows, shareWidth, type TaggedMarginRow } from './exposure-view';

interface PnlBlock {
  snapshotAt: string | null;
  rows: PnlRow[];
  range: { from: string; to: string };
  history: PnlRow[];
}
type Payload = RiskSnapshot & { pnl?: PnlBlock };

/**
 * ── LA SECCIÓN "CIERRE DIARIO (CRM)" ────────────────────────────────────────
 * Vive acá y no en una pantalla aparte a propósito: es EL MISMO número que el
 * histórico de al lado, contado por otra fuente. Kevin (2026-08-31) pidió ver
 * "cómo aparece en el CRM y cómo aparece en Smart Dashboard"; separarlos en
 * dos pantallas es garantizar que nadie los compare.
 *
 * Diferencias que hay que tener presentes al mirarlas juntas:
 *   · El CRM NO incluye prop firm (cero documentos en grupos `real\PropFirm\*`
 *     durante todo agosto); nuestro MT5 sí.
 *   · Nuestro MT5 excluye las cuentas que todavía no están espejadas en
 *     `crm_trading_accounts`; el CRM las tiene desde el primer día. Medido el
 *     2026-08-27: la cuenta 159324 hizo +54.106,96 y estaba en el CRM y no en
 *     nuestra cifra (USD 9.259,66 nuestro vs 64.852,12 del CRM).
 *   · Los días con el universo de cuentas estable coinciden: el 2026-08-29,
 *     119.407,63 nuestro contra 120.094,60 del CRM (0,6%).
 */
type CrmSeries = {
  range: { from: string; to: string };
  rows: CrmDailyPnlRow[];
  daysMissing: string[];
  totals: {
    clientsPnl: number | null;
    brokerPnl: number | null;
    volumeLots: number;
    dealsCount: number;
    daysWithData: number;
    unmatchedAccounts: number;
  };
  last: CrmDailyPnlRow | null;
};

type Seccion = 'pnl' | 'crm' | 'margen' | 'concentracion' | 'detalle' | 'historico';

const countFmt = new Intl.NumberFormat(MONEY_LOCALE, { maximumFractionDigits: 0 });
const lotsFmt = new Intl.NumberFormat(MONEY_LOCALE, { maximumFractionDigits: 2 });
const lotsText = (n: number | null | undefined) =>
  typeof n === 'number' && Number.isFinite(n) ? lotsFmt.format(n) : '—';

/** Para el CSV: el importe y su unidad, porque un CSV se abre sin contexto. */
const csvMoney = (n: number | null, unit: string) =>
  n === null ? '' : `${n} ${unit === 'cents' ? 'cent' : 'USD'}`;

export default function ExposicionPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { company } = useData();
  const router = useRouter();
  const hasRiskAccess = useModuleAccess('risk');
  const { toast, ToastHost } = useToasts();

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [seccion, setSeccion] = useState<Seccion>('pnl');
  const [pdfBusy, setPdfBusy] = useState(false);
  // «Ahora» para la antigüedad de la foto: se toma al cargar/actualizar, no en
  // cada render (un reloj que corre solo re-renderizaría la pantalla).
  const [loadedAt, setLoadedAt] = useState(() => Date.now());

  // El cierre del CRM se pide aparte y sólo cuando se abre su sección: es otra
  // tabla y otro rango, y cargarla siempre haría más lenta una pantalla de
  // riesgo que se abre para mirar el margen.
  const [crm, setCrm] = useState<CrmSeries | null>(null);
  const [crmRange, setCrmRange] = useState<{ from: string; to: string } | null>(null);
  const [crmLoading, setCrmLoading] = useState(false);

  useEffect(() => {
    if (user === null) return;
    if (!hasRiskAccess) router.replace('/');
  }, [user, hasRiskAccess, router]);
  const accessDenied = user !== null && !hasRiskAccess;

  const load = useCallback(
    async (silent = false, r?: { from: string; to: string }) => {
      if (silent) setRefreshing(true);
      else setLoading(true);
      try {
        const qs = r ? `?from=${r.from}&to=${r.to}` : '';
        const res = await apiFetch(`/api/admin/risk-exposure${qs}`);
        const body = await res.json();
        if (!res.ok || body?.success === false) throw new Error(body?.error ?? t('exposure.loadError'));
        setData(body);
        setLoadedAt(Date.now());
        if (body?.pnl?.range) setRange(body.pnl.range);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('exposure.loadError'));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!accessDenied) void load();
  }, [accessDenied, load]);

  const loadCrm = useCallback(
    async (r?: { from: string; to: string }) => {
      setCrmLoading(true);
      try {
        const qs = r ? `?from=${r.from}&to=${r.to}` : '';
        const res = await apiFetch(`/api/admin/crm-daily-pnl${qs}`);
        const body = await res.json();
        if (!res.ok || body?.success === false) throw new Error(body?.error ?? t('exposure.loadError'));
        setCrm(body as CrmSeries);
        if (body?.range) setCrmRange(body.range);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('exposure.loadError'));
      } finally {
        setCrmLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (seccion === 'crm' && crm === null && !crmLoading) void loadCrm();
  }, [seccion, crm, crmLoading, loadCrm]);

  const enRiesgo = useMemo(() => marginRows(data?.critical, data?.watch), [data]);

  // Los hooks van SIEMPRE antes de cualquier return condicional: llamarlos
  // después haría que React vea distinto número de hooks entre renders.
  const margen = useTablePage<TaggedMarginRow>(
    enRiesgo,
    (m) => `${m.login} ${m.email ?? ''} ${m.family} ${m.group_name ?? ''}`,
  );
  const detalle = useTablePage<ExposureRow>(data?.exposure ?? [], (r) => `${r.symbol} ${r.family}`);
  const historia = useTablePage<PnlRow>(data?.pnl?.history ?? [], (r) => `${r.utc_day} ${r.category}`);
  const cierreCrm = useTablePage<CrmDailyPnlRow>(crm?.rows ?? [], (r) => r.utc_day);

  const pagerLabels = {
    prev: t('table.prev'),
    next: t('table.next'),
    range: t('table.range'),
    filtered: t('table.filtered'),
  };

  if (accessDenied) return null;

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-[92px]" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (!data || !data.snapshotAt) {
    return (
      <div className="space-y-4">
        {ToastHost}
        <PageHeader icon={Activity} title={t('exposure.title')} subtitle={t('exposure.subtitle')} />
        <EmptyState icon={Activity} title={t('exposure.noSnapshot')} description={t('exposure.noSnapshotHint')} />
      </div>
    );
  }

  const hoy = new Date().toISOString().slice(0, 10);
  const pnlRows = data.pnl?.rows ?? [];
  const fueraDelCrm = pnlRows.reduce((s, r) => s + (r.accounts_outside_crm ?? 0), 0);
  const fresh = snapshotFreshness(data.snapshotAt, loadedAt);
  const ageLabel = fresh
    ? fresh.minutes < 1
      ? t('ui.ago.now')
      : fresh.minutes < 60
        ? t('ui.ago.min', { n: String(fresh.minutes) })
        : t('ui.ago.h', { n: String(Math.floor(fresh.minutes / 60)) })
    : t('ui.noData');
  const staleAt = fresh?.stale ? data.snapshotAt : undefined;

  const descargarPdf = async () => {
    setPdfBusy(true);
    try {
      // On-demand: jsPDF (~400 KB) sólo baja cuando alguien pide el informe.
      const { generateExposurePDF } = await import('@/lib/pdf-export');
      await generateExposurePDF({
        company: { name: company?.name ?? 'Dashboard', logoUrl: company?.logo_url ?? null },
        range: range ?? { from: hoy, to: hoy },
        snapshotAt: data.snapshotAt ?? new Date().toISOString(),
        live: pnlRows,
        // Lo FILTRADO, no la página: el PDF de un informe recortado a 50 filas
        // sin decirlo sería un informe incorrecto.
        history: historia.filtered,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('exposure.pdfError'));
    } finally {
      setPdfBusy(false);
    }
  };

  const kpis: KpiItem[] = [
    {
      key: 'positions',
      label: t('exposure.kpiPositions'),
      value: data.totalPositions,
      format: 'count',
      hero: true,
      sub: t('exposure.kpiPositionsHint'),
      staleAt,
    },
    {
      key: 'critical',
      label: t('exposure.kpiCritical'),
      value: data.critical.length,
      format: 'count',
      sub: t('exposure.kpiCriticalHint'),
      staleAt,
    },
    {
      key: 'watch',
      label: t('exposure.kpiWatch'),
      value: data.watch.length,
      format: 'count',
      sub: t('exposure.kpiWatchHint', { total: countFmt.format(data.accountsWithMargin) }),
      staleAt,
    },
    {
      key: 'symbols',
      label: t('riskLm.kpiSymbols'),
      value: data.concentration.length,
      format: 'count',
      sub: t('riskLm.kpiSymbolsHint', { n: countFmt.format(data.exposure.length) }),
    },
  ];

  const sectionOptions = [
    { value: 'pnl' as const, label: t('exposure.tabPnl'), count: pnlRows.length },
    // null hasta abrirla: no se sabe, no es 0.
    { value: 'crm' as const, label: t('crmPnl.tab'), count: crm ? crm.rows.length : null },
    { value: 'margen' as const, label: t('exposure.tabMargin'), count: enRiesgo.length },
    { value: 'concentracion' as const, label: t('exposure.tabConcentration'), count: data.concentration.length },
    { value: 'detalle' as const, label: t('exposure.tabDetail'), count: data.exposure.length },
    { value: 'historico' as const, label: t('exposure.tabHistory'), count: data.pnl?.history.length ?? null },
  ];

  // ── Columnas ──────────────────────────────────────────────────────────────
  const pnlCols: FinColumn<PnlRow>[] = [
    {
      key: 'category',
      header: t('exposure.colCategory'),
      cell: (r) => r.category,
      meta: (r) =>
        r.accounts_outside_crm > 0
          ? t('exposure.pnlOutside', { n: String(r.accounts_outside_crm) })
          : t('riskLm.unitLabel', { unit: unitOfCategory(r.category) === 'cents' ? '¢' : 'USD' }),
    },
    {
      key: 'open',
      header: t('exposure.pnlOpen'),
      kind: 'money',
      value: (r) => r.open_pnl,
      cell: (r) => <UnitAmount value={r.open_pnl} unit={unitOfCategory(r.category)} tone="sign" className="font-medium" />,
    },
    {
      key: 'openPos',
      header: t('exposure.colPositions'),
      kind: 'number',
      hideSm: true,
      value: (r) => r.open_positions,
      cell: (r) => (
        <span className={NUM_CLASS}>
          {countFmt.format(r.open_positions)}
          <span className="ml-1 text-[12px] text-text-3">
            {t('riskLm.inAccounts', { n: countFmt.format(r.open_accounts) })}
          </span>
        </span>
      ),
    },
    {
      key: 'closed',
      header: t('exposure.pnlClosed'),
      kind: 'money',
      value: (r) => r.closed_pnl,
      cell: (r) => <UnitAmount value={r.closed_pnl} unit={unitOfCategory(r.category)} tone="sign" className="font-medium" />,
    },
    {
      key: 'deals',
      header: t('exposure.colDeals'),
      kind: 'number',
      hideSm: true,
      value: (r) => r.closed_deals,
      cell: (r) => (
        <span className={NUM_CLASS}>
          {countFmt.format(r.closed_deals)}
          <span className="ml-1 text-[12px] text-text-3">
            {t('riskLm.inAccounts', { n: countFmt.format(r.closed_accounts) })}
          </span>
        </span>
      ),
    },
  ];

  const crmCols: FinColumn<CrmDailyPnlRow>[] = [
    {
      key: 'day',
      header: t('exposure.colDay'),
      cell: (r) => <span className={NUM_CLASS}>{r.utc_day}</span>,
      meta: (r) => (r.utc_day === hoy ? t('exposure.inProgress') : null),
    },
    {
      key: 'broker',
      header: t('crmPnl.colBrokerPnl'),
      kind: 'money',
      value: (r) => (r.pnl_usd === null ? null : -r.pnl_usd),
      cell: (r) => <UnitAmount value={r.pnl_usd === null ? null : -r.pnl_usd} unit="usd" tone="sign" className="font-medium" />,
    },
    {
      key: 'clients',
      header: t('crmPnl.colClientsPnl'),
      kind: 'money',
      hideSm: true,
      value: (r) => r.pnl_usd,
      cell: (r) => <UnitAmount value={r.pnl_usd} unit="usd" tone="sign" />,
    },
    {
      key: 'volume',
      header: t('crmPnl.colVolume'),
      kind: 'number',
      hideSm: true,
      value: (r) => r.volume_lots,
      cell: (r) => <span className={NUM_CLASS}>{lotsText(r.volume_lots)}</span>,
    },
    { key: 'deals', header: t('crmPnl.colDeals'), kind: 'number', hideSm: true, value: (r) => r.deals_count },
    { key: 'accounts', header: t('crmPnl.colAccounts'), kind: 'number', hideSm: true, value: (r) => r.accounts_count },
  ];

  const marginCols: FinColumn<TaggedMarginRow>[] = [
    {
      key: 'level',
      header: t('exposure.colLevel'),
      cell: (m) => <StatusBadge kind={marginKind(m.list)} label={marginLevelText(m.margin_level)} />,
      width: '120px',
    },
    {
      key: 'account',
      header: t('exposure.colAccount'),
      cell: (m) => <span className="font-mono text-[12px]">{m.login}</span>,
      meta: (m) => m.email ?? t('exposure.noEmail'),
    },
    {
      key: 'family',
      header: t('exposure.colFamily'),
      hideSm: true,
      cell: (m) => <FamilyText family={m.family} virtual={m.is_virtual} />,
    },
    {
      key: 'equity',
      header: t('exposure.colEquity'),
      kind: 'money',
      value: (m) => m.equity,
      cell: (m) => <UnitAmount value={m.equity} unit={m.unit} className="font-medium" />,
    },
    {
      key: 'margin',
      header: t('exposure.colMargin'),
      kind: 'money',
      hideSm: true,
      value: (m) => m.margin,
      cell: (m) => <UnitAmount value={m.margin} unit={m.unit} tone="neutral" />,
    },
    {
      key: 'floating',
      header: t('exposure.colFloating'),
      kind: 'money',
      hideSm: true,
      value: (m) => m.floating,
      cell: (m) => <UnitAmount value={m.floating} unit={m.unit} tone="sign" />,
    },
  ];

  const concentrationCols: FinColumn<SymbolConcentration>[] = [
    { key: 'symbol', header: t('exposure.colSymbol'), cell: (c) => <span className="font-medium">{c.symbol}</span> },
    { key: 'positions', header: t('exposure.colPositions'), kind: 'number', value: (c) => c.positions },
    {
      key: 'share',
      header: t('exposure.colShare'),
      align: 'right',
      cell: (c) => <ShareCell share={c.share} />,
      width: '140px',
    },
    {
      key: 'netLots',
      header: t('exposure.colNetLots'),
      kind: 'number',
      hideSm: true,
      value: (c) => c.netLots,
      cell: (c) => <span className={NUM_CLASS}>{lotsText(c.netLots)}</span>,
    },
    {
      key: 'floating',
      header: t('riskLm.colFloatingByFamily'),
      hideSm: true,
      // El flotante va por familia dentro de UNA celda: sumarlo mezclaría
      // centavos con dólares.
      cell: (c) => (
        <div className="flex flex-col items-end gap-0.5 py-1.5 text-right">
          {c.byFamily.map((f) => (
            <span key={f.family} className="text-[12.5px]">
              <span className="mr-1.5 text-text-3">
                {f.family}
                {f.isVirtual ? ` ${t('exposure.virtual')}` : ''}
              </span>
              <UnitAmount value={f.floating} unit={f.unit} tone="sign" />
            </span>
          ))}
        </div>
      ),
      align: 'right',
    },
  ];

  const detailCols: FinColumn<ExposureRow>[] = [
    {
      key: 'symbol',
      header: t('exposure.colSymbol'),
      cell: (r) => <span className="font-medium">{r.symbol}</span>,
      meta: (r) => `${r.family}${r.is_virtual ? ` ${t('exposure.virtual')}` : ''}`,
    },
    { key: 'positions', header: t('exposure.colPositions'), kind: 'number', hideSm: true, value: (r) => r.positions },
    {
      key: 'netLots',
      header: t('exposure.colNetLots'),
      kind: 'number',
      hideSm: true,
      value: (r) => r.net_lots,
      // Sin color: el signo dice de qué lado está el cliente, no si es bueno.
      cell: (r) => <span className={NUM_CLASS}>{lotsText(r.net_lots)}</span>,
    },
    {
      key: 'floating',
      header: t('exposure.colFloating'),
      kind: 'money',
      value: (r) => r.floating,
      cell: (r) => <UnitAmount value={r.floating} unit={r.unit} tone="sign" className="font-medium" />,
    },
    {
      key: 'swap',
      header: t('exposure.colSwap'),
      kind: 'money',
      hideSm: true,
      value: (r) => r.storage,
      cell: (r) => <UnitAmount value={r.storage} unit={r.unit} />,
    },
  ];

  const historyCols: FinColumn<PnlRow>[] = [
    {
      key: 'day',
      header: t('exposure.colDay'),
      cell: (r) => <span className={NUM_CLASS}>{r.utc_day}</span>,
      // El día en curso no es un cierre y compararlo con días enteros sin
      // saberlo lleva a conclusiones falsas.
      meta: (r) => (r.utc_day === hoy ? `${r.category} · ${t('exposure.inProgress')}` : r.category),
    },
    {
      key: 'closed',
      header: t('exposure.colClosedPnl'),
      kind: 'money',
      value: (r) => r.closed_pnl,
      cell: (r) => <UnitAmount value={r.closed_pnl} unit={unitOfCategory(r.category)} tone="sign" className="font-medium" />,
    },
    { key: 'deals', header: t('exposure.colDeals'), kind: 'number', hideSm: true, value: (r) => r.closed_deals },
    {
      key: 'open',
      header: t('exposure.colOpenPnl'),
      kind: 'money',
      hideSm: true,
      value: (r) => r.open_pnl,
      cell: (r) => <UnitAmount value={r.open_pnl} unit={unitOfCategory(r.category)} tone="sign" />,
    },
    { key: 'positions', header: t('exposure.colPositions'), kind: 'number', hideSm: true, value: (r) => r.open_positions },
  ];

  return (
    <div className="space-y-4">
      {ToastHost}

      <PageHeader
        icon={Activity}
        title={t('exposure.title')}
        subtitle={t('exposure.subtitle')}
        actions={
          <ActionButton loading={refreshing} onClick={() => void load(true, range ?? undefined)}>
            {!refreshing && <RefreshCw className="size-4" aria-hidden />}
            {t('exposure.refresh')}
          </ActionButton>
        }
      />

      {/* Una pantalla de riesgo tiene que decir de cuándo es su dato y a qué
          cuentas se refiere. Las dos cosas cambian lo que significan las cifras. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-text-2">
        <StatusBadge kind={fresh?.stale ? 'stale' : 'ok'} label={ageLabel} />
        <span className={NUM_CLASS}>{t('exposure.asOf', { when: formatDateTime(data.snapshotAt) })}</span>
        <span className="text-text-3">{t('exposure.scopeNotice')}</span>
        {fueraDelCrm > 0 && (
          <span className="text-text-3">{t('exposure.pnlOutside', { n: String(fueraDelCrm) })}</span>
        )}
      </div>

      {fresh?.stale && (
        <Notice
          kind="stale"
          title={t('riskLm.staleTitle', { age: ageLabel })}
          action={
            <ActionButton variant="ghost" onClick={() => void load(true, range ?? undefined)} loading={refreshing}>
              {t('exposure.refresh')}
            </ActionButton>
          }
        >
          {t('riskLm.staleBody', { min: String(SNAPSHOT_STALE_MIN) })}
        </Notice>
      )}

      <KpiStrip items={kpis} />

      <Segmented<Seccion>
        aria-label={t('exposure.sectionsLabel')}
        value={seccion}
        onChange={setSeccion}
        options={sectionOptions}
        className="max-w-full overflow-x-auto"
      />

      {/* ── PNL en vivo ──────────────────────────────────────────────────── */}
      {seccion === 'pnl' && (
        <Panel
          title={t('exposure.pnlTitle')}
          hint={t('exposure.pnlHint')}
          flush
          actions={
            <TableCsvButton<PnlRow>
              rows={pnlRows}
              filename="PNL_por_categoria"
              label={t('table.csv')}
              headers={[
                t('exposure.colCategory'), t('exposure.colUnit'), t('exposure.pnlOpen'),
                t('exposure.colPositions'), t('exposure.colAccounts'), t('exposure.pnlClosed'),
                t('exposure.colDeals'), t('exposure.colOutsideCrm'),
              ]}
              toRow={(r) => [
                r.category,
                r.category === 'CENT' ? 'cent' : 'USD',
                csvMoney(r.open_pnl, unitOfCategory(r.category)),
                r.open_positions, r.open_accounts,
                csvMoney(r.closed_pnl, unitOfCategory(r.category)),
                r.closed_deals, r.accounts_outside_crm,
              ]}
            />
          }
        >
          <FinTable<PnlRow>
            caption={t('exposure.pnlTitle')}
            columns={pnlCols}
            rows={pnlRows}
            rowKey={(r) => r.category}
            empty={<EmptyState compact title={t('exposure.pnlEmpty')} description={t('exposure.pnlEmptyHint')} />}
          />
        </Panel>
      )}

      {/* ── Cierre diario del CRM: el número real, guardado día a día ────── */}
      {seccion === 'crm' && (
        <Panel
          title={t('crmPnl.title')}
          hint={t('crmPnl.hint')}
          flush
          actions={
            <TableCsvButton<CrmDailyPnlRow>
              rows={cierreCrm.filtered}
              filename="Cierre_diario_PNL_CRM"
              label={t('table.csv')}
              headers={[
                t('exposure.colDay'), t('crmPnl.colClientsPnl'), t('crmPnl.colBrokerPnl'),
                t('crmPnl.colVolume'), t('crmPnl.colDeals'), t('crmPnl.colAccounts'),
                t('crmPnl.colExcluded'),
              ]}
              toRow={(r) => [
                r.utc_day === hoy ? `${r.utc_day} (${t('exposure.inProgress')})` : r.utc_day,
                // Un CSV se abre sin contexto: el hueco viaja como texto y
                // NUNCA como 0, que en una hoja de cálculo se suma solo.
                r.pnl_usd === null ? t('crmPnl.noData') : r.pnl_usd,
                r.pnl_usd === null ? t('crmPnl.noData') : -r.pnl_usd,
                r.volume_lots, r.deals_count, r.accounts_count, r.unmatched_accounts,
              ]}
            />
          }
        >
          <div className="space-y-3 px-4 py-3">
            <div className="flex flex-wrap items-end gap-2">
              <DateRange
                today={hoy}
                value={crmRange}
                onChange={(next, changed) => {
                  setCrmRange(next);
                  if (changed) void loadCrm(next);
                }}
              />
            </div>

            {crmLoading && !crm ? (
              <Skeleton className="h-[92px]" />
            ) : (
              <>
                <KpiStrip
                  items={[
                    {
                      key: 'broker',
                      label: t('crmPnl.kpiBrokerRange'),
                      value: crm?.totals.brokerPnl ?? null,
                      format: 'money',
                      tone: 'sign',
                      hero: true,
                      sub: t('crmPnl.kpiBrokerRangeHint', { days: String(crm?.totals.daysWithData ?? 0) }),
                    },
                    {
                      key: 'last',
                      label: t('crmPnl.kpiLastClose'),
                      value: crm?.last == null || crm.last.pnl_usd === null ? null : -crm.last.pnl_usd,
                      format: 'money',
                      tone: 'sign',
                      sub: crm?.last ? t('crmPnl.kpiLastCloseHint', { day: crm.last.utc_day }) : t('crmPnl.noData'),
                    },
                    {
                      key: 'deals',
                      label: t('crmPnl.kpiDeals'),
                      value: crm ? crm.totals.dealsCount : null,
                      format: 'count',
                      sub: crm
                        ? t('riskLm.lotsSub', { lots: lotsText(crm.totals.volumeLots) })
                        : t('crmPnl.kpiDealsHint'),
                    },
                  ]}
                />

                {/* Un hueco NO puede ser invisible: un acumulado de treinta
                    días construido con veinticinco es un número más chico y
                    perfectamente creíble. */}
                {crm && crm.daysMissing.length > 0 && (
                  <Notice kind="pend" title={t('riskLm.missingDaysTitle', { n: String(crm.daysMissing.length) })}>
                    {t('crmPnl.missingDays', {
                      n: String(crm.daysMissing.length),
                      days: crm.daysMissing.slice(0, 8).join(', '),
                    })}
                  </Notice>
                )}
                {crm && crm.totals.unmatchedAccounts > 0 && (
                  <p className="text-[12.5px] text-text-3">
                    {t('crmPnl.excludedNotice', { n: String(crm.totals.unmatchedAccounts) })}
                  </p>
                )}
              </>
            )}
          </div>

          <FinTable<CrmDailyPnlRow>
            caption={t('crmPnl.title')}
            columns={crmCols}
            rows={cierreCrm.pageRows}
            rowKey={(r) => r.utc_day}
            maxHeight="60vh"
            empty={
              <EmptyState compact icon={CalendarDays} title={t('crmPnl.empty')} description={t('crmPnl.emptyHint')} />
            }
          />
          <TablePager
            page={cierreCrm.page}
            pageCount={cierreCrm.pageCount}
            shown={cierreCrm.pageRows.length}
            total={cierreCrm.total}
            filteredTotal={cierreCrm.filtered.length}
            onPage={cierreCrm.setPage}
            labels={pagerLabels}
          />
        </Panel>
      )}

      {/* ── Margen: cuentas que pueden liquidarse ────────────────────────── */}
      {seccion === 'margen' && (
        <Panel
          title={t('exposure.marginTitle')}
          hint={t('exposure.marginHint')}
          flush
          actions={
            <>
              <TableSearch value={margen.query} onChange={margen.setQuery} placeholder={t('exposure.searchMargin')} />
              <TableCsvButton<TaggedMarginRow>
                rows={margen.filtered}
                filename="Cuentas_en_riesgo_de_margen"
                label={t('table.csv')}
                headers={[
                  t('exposure.colLevel'), t('exposure.colAccount'), t('exposure.colClient'),
                  t('exposure.colFamily'), t('exposure.colEquity'), t('exposure.colMargin'),
                  t('exposure.colFloating'),
                ]}
                toRow={(m) => [
                  m.margin_level ?? '', m.login, m.email ?? '',
                  m.is_virtual ? `${m.family} (virtual)` : m.family,
                  csvMoney(m.equity, m.unit), csvMoney(m.margin, m.unit),
                  csvMoney(m.floating, m.unit),
                ]}
              />
            </>
          }
        >
          <FinTable<TaggedMarginRow>
            caption={t('exposure.marginTitle')}
            columns={marginCols}
            rows={margen.pageRows}
            rowKey={(m) => String(m.login)}
            maxHeight="60vh"
            empty={
              <EmptyState
                compact
                title={t('exposure.marginEmpty')}
                description={t('exposure.marginEmptyHint', { total: String(data.accountsWithMargin) })}
              />
            }
          />
          <TablePager
            page={margen.page}
            pageCount={margen.pageCount}
            shown={margen.pageRows.length}
            total={margen.total}
            filteredTotal={margen.filtered.length}
            onPage={margen.setPage}
            labels={pagerLabels}
          />
        </Panel>
      )}

      {/* ── Concentración ────────────────────────────────────────────────── */}
      {seccion === 'concentracion' && (
        <Panel
          title={t('exposure.concentrationTitle')}
          hint={t('exposure.concentrationHint')}
          flush
          actions={
            <TableCsvButton
              rows={data.concentration}
              filename="Concentracion_por_simbolo"
              label={t('table.csv')}
              headers={[
                t('exposure.colSymbol'), t('exposure.colPositions'), t('exposure.colShare'),
                t('exposure.colNetLots'), t('exposure.colFloating'),
              ]}
              toRow={(c) => [
                c.symbol, c.positions, `${c.share}%`, c.netLots,
                // El flotante va por familia dentro de UNA celda: aplanarlo en
                // columnas obligaría a inventar una columna por familia, y
                // sumarlo mezclaría centavos con dólares.
                c.byFamily
                  .map((f) => `${f.family}${f.isVirtual ? ' (virtual)' : ''}: ${csvMoney(f.floating, f.unit)}`)
                  .join(' | '),
              ]}
            />
          }
          footer={t('riskLm.concentrationFoot', { n: countFmt.format(data.concentration.length) })}
        >
          <FinTable<SymbolConcentration>
            caption={t('exposure.concentrationTitle')}
            columns={concentrationCols}
            rows={data.concentration}
            rowKey={(c) => c.symbol}
            empty={<EmptyState compact title={t('exposure.detailEmpty')} />}
          />
        </Panel>
      )}

      {/* ── El detalle ───────────────────────────────────────────────────── */}
      {seccion === 'detalle' && (
        <Panel
          title={t('exposure.detailTitle')}
          hint={t('exposure.detailHint')}
          flush
          actions={
            <>
              <TableSearch value={detalle.query} onChange={detalle.setQuery} placeholder={t('exposure.searchDetail')} />
              <TableCsvButton<ExposureRow>
                rows={detalle.filtered}
                filename="Exposicion_por_familia_y_simbolo"
                label={t('table.csv')}
                headers={[
                  t('exposure.colFamily'), t('exposure.colSymbol'), t('exposure.colPositions'),
                  t('exposure.colNetLots'), t('exposure.colFloating'), t('exposure.colSwap'),
                ]}
                toRow={(r) => [
                  r.is_virtual ? `${r.family} (virtual)` : r.family,
                  r.symbol, r.positions, r.net_lots ?? '',
                  csvMoney(r.floating, r.unit), csvMoney(r.storage, r.unit),
                ]}
              />
            </>
          }
        >
          <FinTable<ExposureRow>
            caption={t('exposure.detailTitle')}
            columns={detailCols}
            rows={detalle.pageRows}
            rowKey={(r) => `${r.family}|${r.symbol}|${r.is_virtual ? 'v' : 'r'}`}
            maxHeight="60vh"
            empty={<EmptyState compact title={t('exposure.detailEmpty')} />}
          />
          <TablePager
            page={detalle.page}
            pageCount={detalle.pageCount}
            shown={detalle.pageRows.length}
            total={detalle.total}
            filteredTotal={detalle.filtered.length}
            onPage={detalle.setPage}
            labels={pagerLabels}
          />
        </Panel>
      )}

      {/* ── Histórico de cierres: la sección con filtro de fechas ────────── */}
      {seccion === 'historico' && (
        <Panel
          title={t('exposure.historyTitle')}
          hint={t('exposure.historyHint')}
          flush
          actions={
            <>
              <TableCsvButton<PnlRow>
                rows={historia.filtered}
                filename="Cierres_diarios_PNL"
                label={t('table.csv')}
                headers={[
                  t('exposure.colDay'), t('exposure.colCategory'), t('exposure.colClosedPnl'),
                  t('exposure.colDeals'), t('exposure.colAccounts'), t('exposure.colOpenPnl'),
                  t('exposure.colPositions'), t('exposure.colOutsideCrm'),
                ]}
                toRow={(r) => [
                  // El día en curso se marca EN el CSV: leído en una hoja de
                  // cálculo, un día corto parece un cierre malo.
                  r.utc_day === hoy ? `${r.utc_day} (${t('exposure.inProgress')})` : r.utc_day,
                  r.category,
                  csvMoney(r.closed_pnl, unitOfCategory(r.category)),
                  r.closed_deals, r.closed_accounts,
                  csvMoney(r.open_pnl, unitOfCategory(r.category)),
                  r.open_positions, r.accounts_outside_crm,
                ]}
              />
              <ActionButton
                loading={pdfBusy}
                disabled={historia.filtered.length === 0}
                onClick={() => void descargarPdf()}
              >
                {!pdfBusy && <FileText className="size-4" aria-hidden />}
                {t('exposure.pdf')}
              </ActionButton>
            </>
          }
        >
          <div className="flex flex-wrap items-end gap-2 px-4 py-3">
            <DateRange
              today={hoy}
              value={range}
              onChange={(next, changed) => {
                setRange(next);
                if (changed) void load(true, next);
              }}
            />
            <TableSearch value={historia.query} onChange={historia.setQuery} placeholder={t('exposure.searchHistory')} />
          </div>
          <FinTable<PnlRow>
            caption={t('exposure.historyTitle')}
            columns={historyCols}
            rows={historia.pageRows}
            rowKey={(r) => `${r.utc_day}|${r.category}`}
            maxHeight="60vh"
            empty={<EmptyState compact icon={CalendarDays} title={t('exposure.pnlEmpty')} />}
          />
          <TablePager
            page={historia.page}
            pageCount={historia.pageCount}
            shown={historia.pageRows.length}
            total={historia.total}
            filteredTotal={historia.filtered.length}
            onPage={historia.setPage}
            labels={pagerLabels}
          />
        </Panel>
      )}
    </div>
  );
}

/**
 * Desde / Hasta. Componente de módulo (no definido dentro del render: se
 * remontaría en cada render y el input perdería el foco).
 */
function DateRange({
  today,
  value,
  onChange,
}: {
  today: string;
  value: { from: string; to: string } | null;
  onChange: (next: { from: string; to: string }, changed: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('exposure.historyFrom')}>
        <Input
          type="date"
          value={value?.from ?? ''}
          max={value?.to ?? today}
          onChange={(e) => onChange({ from: e.target.value, to: value?.to ?? today }, e.target.value)}
          className="w-[150px]"
        />
      </Field>
      <Field label={t('exposure.historyTo')}>
        <Input
          type="date"
          value={value?.to ?? ''}
          min={value?.from ?? ''}
          max={today}
          onChange={(e) => onChange({ from: value?.from ?? today, to: e.target.value }, e.target.value)}
          className="w-[150px]"
        />
      </Field>
    </>
  );
}

/** Familia + «(virtual)» en `text-3`: el capital virtual no es dinero de nadie. */
function FamilyText({ family, virtual }: { family: string; virtual: boolean }) {
  const { t } = useI18n();
  return (
    <span className="text-[12.5px] text-text-2">
      {family}
      {virtual && <span className="ml-1 text-text-3">{t('exposure.virtual')}</span>}
    </span>
  );
}

/**
 * Columna de participación (spec §5.3): % tabular + barra 64×6 sobre
 * `surface-sunk` con relleno `brand-ink` al 75 %. El peso es en POSICIONES,
 * que sí son comparables entre familias.
 */
function ShareCell({ share }: { share: number }) {
  const w = shareWidth(share);
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span className={cn(NUM_CLASS, 'text-[13px]')}>{w === null ? '—' : `${formatNumber(share)} %`}</span>
      <span aria-hidden className="block h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunk">
        {w !== null && <span className="block h-full rounded-full bg-brand-ink/75" style={{ width: `${w}%` }} />}
      </span>
    </span>
  );
}
