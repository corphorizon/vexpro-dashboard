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
// ── POR QUÉ PESTAÑAS Y NO UNA COLUMNA LARGA ────────────────────────────────
// Las cuatro preguntas que responde esta pantalla se hacen en momentos
// distintos: "¿me estoy quedando corto de margen?" es una urgencia y "¿cómo
// cerró la semana?" es una revisión. Apiladas, la urgente queda a tres
// scrolls de la primera pantalla.
//
// Los KPI quedan ARRIBA de las pestañas a propósito: son el resumen que hay
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
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Activity, AlertTriangle, Clock, Layers, RefreshCw, CalendarDays, FileText,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToasts } from '@/components/ui/toast';
import { SectionTabs } from '@/components/ui/section-tabs';
import {
  useTablePage, TableSearch, TablePager, TableCsvButton,
} from '@/components/ui/table-toolbar';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { cn, formatNumber } from '@/lib/utils';
import { formatDateTime } from '@/lib/dates';
import { generateExposurePDF } from '@/lib/pdf-export';
import type { RiskSnapshot, MarginRow, ExposureRow, PnlRow } from '@/lib/mt5-sync/risk-query';
import type { CrmDailyPnlRow } from '@/lib/crm-sync/daily-pnl-query';

interface PnlBlock {
  snapshotAt: string | null;
  rows: PnlRow[];
  range: { from: string; to: string };
  history: PnlRow[];
}
type Payload = RiskSnapshot & { pnl?: PnlBlock };

/**
 * ── LA PESTAÑA "CIERRE DIARIO (CRM)" ────────────────────────────────────────
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

/** La categoría dice la unidad: sólo CENT está denominada en centavos. */
const unitOfCategory = (c: string) => (c === 'CENT' ? 'cents' : 'account_currency');

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

  // El cierre del CRM se pide aparte y sólo cuando se abre su pestaña: es otra
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

  const enRiesgo = [...(data?.critical ?? []), ...(data?.watch ?? [])];

  // Los hooks van SIEMPRE antes de cualquier return condicional: llamarlos
  // después haría que React vea distinto número de hooks entre renders.
  const margen = useTablePage<MarginRow>(
    enRiesgo,
    (m) => `${m.login} ${m.email ?? ''} ${m.family} ${m.group_name ?? ''}`,
  );
  const detalle = useTablePage<ExposureRow>(
    data?.exposure ?? [],
    (r) => `${r.symbol} ${r.family}`,
  );
  const historia = useTablePage<PnlRow>(
    data?.pnl?.history ?? [],
    (r) => `${r.utc_day} ${r.category}`,
  );
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

  const hoy = new Date().toISOString().slice(0, 10);
  const pnlRows = data.pnl?.rows ?? [];
  const fueraDelCrm = pnlRows.reduce((s, r) => s + (r.accounts_outside_crm ?? 0), 0);

  const descargarPdf = async () => {
    setPdfBusy(true);
    try {
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

  const tabs = [
    { value: 'pnl' as const, label: t('exposure.tabPnl'), count: pnlRows.length },
    { value: 'crm' as const, label: t('crmPnl.tab'), count: crm?.rows.length },
    {
      value: 'margen' as const,
      label: t('exposure.tabMargin'),
      count: enRiesgo.length,
      tone: data.critical.length > 0 ? ('negative' as const) : ('default' as const),
    },
    { value: 'concentracion' as const, label: t('exposure.tabConcentration'), count: data.concentration.length },
    { value: 'detalle' as const, label: t('exposure.tabDetail'), count: data.exposure.length },
    { value: 'historico' as const, label: t('exposure.tabHistory'), count: data.pnl?.history.length ?? 0 },
  ];

  return (
    <div className="space-y-6">
      {ToastHost}

      <PageHeader
        icon={Activity}
        title={t('exposure.title')}
        subtitle={t('exposure.subtitle')}
        actions={
          <Button variant="secondary" size="sm" loading={refreshing} onClick={() => void load(true, range ?? undefined)}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            {t('exposure.refresh')}
          </Button>
        }
      />

      {/* Una pantalla de riesgo tiene que decir de cuándo es su dato y a qué
          cuentas se refiere. Las dos cosas cambian lo que significan las cifras. */}
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted px-4 py-3 text-sm">
        <Clock className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden />
        <p className="text-muted-foreground">
          {t('exposure.asOf', { when: formatDateTime(data.snapshotAt) })} · {t('exposure.scopeNotice')}
          {fueraDelCrm > 0 && ` · ${t('exposure.pnlOutside', { n: String(fueraDelCrm) })}`}
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

      <SectionTabs<Seccion>
        value={seccion}
        onChange={setSeccion}
        tabs={tabs}
        label={t('exposure.sectionsLabel')}
      />

      {/* ── PNL en vivo ──────────────────────────────────────────────────── */}
      {seccion === 'pnl' && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>{t('exposure.pnlTitle')}</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">{t('exposure.pnlHint')}</p>
            </div>
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
          </div>

          {pnlRows.length === 0 ? (
            <div className="mt-4">
              <EmptyState compact title={t('exposure.pnlEmpty')} description={t('exposure.pnlEmptyHint')} />
            </div>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {pnlRows.map((r) => {
                const unit = unitOfCategory(r.category);
                return (
                  <div key={r.category} className="rounded-lg border border-border p-4">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{r.category}</span>
                      <Badge variant="neutral">{unit === 'cents' ? '¢' : 'USD'}</Badge>
                    </div>

                    <dl className="mt-3 space-y-3">
                      <div>
                        <dt className="text-xs text-muted-foreground">{t('exposure.pnlOpen')}</dt>
                        <dd className="text-lg font-semibold">
                          <Money value={r.open_pnl} unit={unit} />
                        </dd>
                        <dd className="text-xs text-muted-foreground">
                          {t('exposure.pnlPositions', {
                            positions: formatNumber(r.open_positions),
                            accounts: formatNumber(r.open_accounts),
                          })}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">{t('exposure.pnlClosed')}</dt>
                        <dd className="text-lg font-semibold">
                          <Money value={r.closed_pnl} unit={unit} />
                        </dd>
                        <dd className="text-xs text-muted-foreground">
                          {t('exposure.pnlDeals', {
                            deals: formatNumber(r.closed_deals),
                            accounts: formatNumber(r.closed_accounts),
                          })}
                        </dd>
                      </div>
                    </dl>

                    {r.accounts_outside_crm > 0 && (
                      <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
                        {t('exposure.pnlOutside', { n: String(r.accounts_outside_crm) })}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* ── Cierre diario del CRM: el número real, guardado día a día ────── */}
      {seccion === 'crm' && (
        <Card className="p-0 overflow-hidden">
          <div className="px-4 pt-4">
            <CardTitle>{t('crmPnl.title')}</CardTitle>
            <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('crmPnl.hint')}</p>

            <div className="mb-3 flex flex-wrap items-end gap-3">
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">{t('exposure.historyFrom')}</span>
                <input
                  type="date"
                  value={crmRange?.from ?? ''}
                  max={crmRange?.to ?? hoy}
                  onChange={(e) => {
                    const next = { from: e.target.value, to: crmRange?.to ?? hoy };
                    setCrmRange(next);
                    if (e.target.value) void loadCrm(next);
                  }}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">{t('exposure.historyTo')}</span>
                <input
                  type="date"
                  value={crmRange?.to ?? ''}
                  min={crmRange?.from ?? ''}
                  max={hoy}
                  onChange={(e) => {
                    const next = { from: crmRange?.from ?? hoy, to: e.target.value };
                    setCrmRange(next);
                    if (e.target.value) void loadCrm(next);
                  }}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm"
                />
              </label>
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
            </div>

            {crmLoading && !crm ? (
              <div className="pb-4">
                <Skeleton className="h-40" />
              </div>
            ) : (
              <>
                <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  <StatCard
                    icon={Activity}
                    emphasis
                    tone={
                      crm?.totals.brokerPnl === null || crm?.totals.brokerPnl === undefined
                        ? 'neutral'
                        : crm.totals.brokerPnl >= 0
                          ? 'positive'
                          : 'negative'
                    }
                    label={t('crmPnl.kpiBrokerRange')}
                    value={
                      crm?.totals.brokerPnl === null || crm?.totals.brokerPnl === undefined
                        ? '—'
                        : formatNumber(crm.totals.brokerPnl)
                    }
                    hint={t('crmPnl.kpiBrokerRangeHint', {
                      days: String(crm?.totals.daysWithData ?? 0),
                    })}
                  />
                  <StatCard
                    icon={CalendarDays}
                    label={t('crmPnl.kpiLastClose')}
                    value={
                      crm?.last == null || crm.last.pnl_usd === null
                        ? '—'
                        : formatNumber(-crm.last.pnl_usd)
                    }
                    hint={
                      crm?.last
                        ? t('crmPnl.kpiLastCloseHint', { day: crm.last.utc_day })
                        : t('crmPnl.noData')
                    }
                  />
                  <StatCard
                    icon={Layers}
                    label={t('crmPnl.kpiVolume')}
                    value={crm ? formatNumber(crm.totals.volumeLots) : '—'}
                    hint={t('crmPnl.kpiVolumeHint')}
                  />
                  <StatCard
                    icon={Activity}
                    label={t('crmPnl.kpiDeals')}
                    value={crm ? formatNumber(crm.totals.dealsCount) : '—'}
                    hint={t('crmPnl.kpiDealsHint')}
                  />
                </div>

                {/* Un hueco NO puede ser invisible: un acumulado de treinta
                    días construido con veinticinco es un número más chico y
                    perfectamente creíble. */}
                {crm && crm.daysMissing.length > 0 && (
                  <p className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
                    {t('crmPnl.missingDays', {
                      n: String(crm.daysMissing.length),
                      days: crm.daysMissing.slice(0, 8).join(', '),
                    })}
                  </p>
                )}
                {crm && crm.totals.unmatchedAccounts > 0 && (
                  <p className="mb-3 text-xs text-muted-foreground">
                    {t('crmPnl.excludedNotice', { n: String(crm.totals.unmatchedAccounts) })}
                  </p>
                )}
              </>
            )}
          </div>

          <DataTable<CrmDailyPnlRow>
            stickyHeader
            zebra
            density="compact"
            data={cierreCrm.pageRows}
            empty={
              <EmptyState
                compact
                icon={CalendarDays}
                title={t('crmPnl.empty')}
                description={t('crmPnl.emptyHint')}
              />
            }
            columns={[
              {
                header: t('exposure.colDay'),
                accessor: (r) => (
                  <span className="tabular-nums">
                    {r.utc_day}
                    {r.utc_day === hoy && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t('exposure.inProgress')}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                header: t('crmPnl.colBrokerPnl'),
                align: 'right',
                accessor: (r) => <Money value={r.pnl_usd === null ? null : -r.pnl_usd} unit="usd" />,
              },
              {
                header: t('crmPnl.colClientsPnl'),
                align: 'right',
                accessor: (r) => <Money value={r.pnl_usd} unit="usd" />,
              },
              {
                header: t('crmPnl.colVolume'),
                align: 'right',
                accessor: (r) => <span className="tabular-nums">{formatNumber(r.volume_lots)}</span>,
              },
              {
                header: t('crmPnl.colDeals'),
                align: 'right',
                accessor: (r) => <span className="tabular-nums">{formatNumber(r.deals_count)}</span>,
              },
              {
                header: t('crmPnl.colAccounts'),
                align: 'right',
                accessor: (r) => <span className="tabular-nums">{formatNumber(r.accounts_count)}</span>,
              },
            ]}
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
        </Card>
      )}

      {/* ── Margen: cuentas que pueden liquidarse ────────────────────────── */}
      {seccion === 'margen' && (
        <Card className="p-0 overflow-hidden">
          <div className="px-4 pt-4">
            <CardTitle>{t('exposure.marginTitle')}</CardTitle>
            <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('exposure.marginHint')}</p>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <TableSearch
                value={margen.query}
                onChange={margen.setQuery}
                placeholder={t('exposure.searchMargin')}
              />
              <TableCsvButton<MarginRow>
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
            </div>
          </div>
          <DataTable<MarginRow>
            zebra
            density="compact"
            data={margen.pageRows}
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
                accessor: (m) => <span className="text-xs">{m.email ?? t('exposure.noEmail')}</span>,
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
          <TablePager
            page={margen.page}
            pageCount={margen.pageCount}
            shown={margen.pageRows.length}
            total={margen.total}
            filteredTotal={margen.filtered.length}
            onPage={margen.setPage}
            labels={pagerLabels}
          />
        </Card>
      )}

      {/* ── Concentración ────────────────────────────────────────────────── */}
      {seccion === 'concentracion' && (
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>{t('exposure.concentrationTitle')}</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">{t('exposure.concentrationHint')}</p>
            </div>
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
          </div>
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
      )}

      {/* ── El detalle ───────────────────────────────────────────────────── */}
      {seccion === 'detalle' && (
        <Card className="p-0 overflow-hidden">
          <div className="px-4 pt-4">
            <CardTitle>{t('exposure.detailTitle')}</CardTitle>
            <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('exposure.detailHint')}</p>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <TableSearch
                value={detalle.query}
                onChange={detalle.setQuery}
                placeholder={t('exposure.searchDetail')}
              />
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
            </div>
          </div>
          <DataTable<ExposureRow>
            stickyHeader
            zebra
            density="compact"
            data={detalle.pageRows}
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
          <TablePager
            page={detalle.page}
            pageCount={detalle.pageCount}
            shown={detalle.pageRows.length}
            total={detalle.total}
            filteredTotal={detalle.filtered.length}
            onPage={detalle.setPage}
            labels={pagerLabels}
          />
        </Card>
      )}

      {/* ── Histórico de cierres: la sección con filtro de fechas ────────── */}
      {seccion === 'historico' && (
        <Card className="p-0 overflow-hidden">
          <div className="px-4 pt-4">
            <CardTitle>{t('exposure.historyTitle')}</CardTitle>
            <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('exposure.historyHint')}</p>

            <div className="mb-3 flex flex-wrap items-end gap-3">
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">{t('exposure.historyFrom')}</span>
                <input
                  type="date"
                  value={range?.from ?? ''}
                  max={range?.to ?? hoy}
                  onChange={(e) => {
                    const next = { from: e.target.value, to: range?.to ?? hoy };
                    setRange(next);
                    if (e.target.value) void load(true, next);
                  }}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                <span className="mb-1 block">{t('exposure.historyTo')}</span>
                <input
                  type="date"
                  value={range?.to ?? ''}
                  min={range?.from ?? ''}
                  max={hoy}
                  onChange={(e) => {
                    const next = { from: range?.from ?? hoy, to: e.target.value };
                    setRange(next);
                    if (e.target.value) void load(true, next);
                  }}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-sm"
                />
              </label>
              <TableSearch
                value={historia.query}
                onChange={historia.setQuery}
                placeholder={t('exposure.searchHistory')}
              />
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
              <Button
                variant="secondary"
                size="sm"
                loading={pdfBusy}
                disabled={historia.filtered.length === 0}
                onClick={() => void descargarPdf()}
              >
                <FileText className="h-4 w-4" aria-hidden />
                {t('exposure.pdf')}
              </Button>
            </div>
          </div>

          <DataTable<PnlRow>
            stickyHeader
            zebra
            density="compact"
            data={historia.pageRows}
            empty={<EmptyState compact icon={CalendarDays} title={t('exposure.pnlEmpty')} />}
            columns={[
              {
                header: t('exposure.colDay'),
                accessor: (r) => (
                  <span className="tabular-nums">
                    {r.utc_day}
                    {/* El día en curso no es un cierre y compararlo con días
                        enteros sin saberlo lleva a conclusiones falsas. */}
                    {r.utc_day === hoy && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {t('exposure.inProgress')}
                      </span>
                    )}
                  </span>
                ),
              },
              { header: t('exposure.colCategory'), accessor: (r) => r.category },
              {
                header: t('exposure.colClosedPnl'),
                align: 'right',
                accessor: (r) => <Money value={r.closed_pnl} unit={unitOfCategory(r.category)} />,
              },
              {
                header: t('exposure.colDeals'),
                align: 'right',
                accessor: (r) => <span className="tabular-nums">{formatNumber(r.closed_deals)}</span>,
              },
              {
                header: t('exposure.colOpenPnl'),
                align: 'right',
                accessor: (r) => <Money value={r.open_pnl} unit={unitOfCategory(r.category)} />,
              },
              {
                header: t('exposure.colPositions'),
                align: 'right',
                accessor: (r) => <span className="tabular-nums">{formatNumber(r.open_positions)}</span>,
              },
            ]}
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
        </Card>
      )}
    </div>
  );
}
