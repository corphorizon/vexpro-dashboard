'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /hedge-fund — el módulo Hedge Fund (migración 125).
//
// Cinco pestañas sobre el espejo del CRM: Resumen, Programas, Inversiones,
// Pagos y Vencimientos.
//
// ── TRES REGLAS QUE ESTA PANTALLA NO ROMPE ─────────────────────────────────
//
//  1. VA POR APARTE. Kevin, 2026-09-02: estos números NO se integran a
//     balances, ni al resumen general, ni a la cadena de distribución. Esta
//     pantalla no importa nada de `distribution*.ts` ni del data-context
//     contable: se alimenta sólo de `/api/admin/hedge-fund/*`.
//
//  2. LA EXCLUSIÓN SE VE. El fondo de prueba `qa-tst` y el usuario "Dev Sup"
//     quedan fuera de todas las cifras, y el badge «N excluidos (pruebas)» lo
//     dice cuando N > 0. Una exclusión silenciosa es indistinguible de un cruce
//     roto (§1.2).
//
//  3. `null` NO SE DIBUJA COMO 0. Donde no hay dato va «—» y la leyenda «sin
//     datos». Es literal en dos lugares donde importa: los rendimientos
//     mensuales reales (colección VACÍA hoy en las dos empresas) y el ticket
//     promedio de un fondo sin inversiones activas.
//
// ── EL TÍTULO LO PONE LA EMPRESA ───────────────────────────────────────────
// Vex Pro lo vende como «Vex Capital» (Kevin, 2026-09-02). El rótulo vive en
// `companies.hedge_fund_label` (migración 126) y se resuelve con
// `moduleDisplayLabel`, el MISMO helper que usa el menú: título y menú no
// pueden decir cosas distintas. NULL = 'Hedge Fund'.
//
// ── LA CARGA ES POR PESTAÑA ────────────────────────────────────────────────
// El Resumen y los Programas salen de la MISMA llamada (`/overview`): son la
// misma consulta y partirla daría dos números que pueden separarse. Las otras
// tres se piden al abrirlas y se cachean en memoria — abrir Pagos no debería
// costar el calendario de vencimientos.
//
// ── «LIBRO MAYOR» (2026-10-12) ─────────────────────────────────────────────
// Sólo presentación; los números son los mismos de los cinco endpoints.
//   · Ocho StatCard con íconos de color → DOS franjas de KPIs (la franja
//     admite 5): «capital» (bajo gestión, hero · pasivo · clientes ·
//     inversiones activas) y «flujos» (rendimientos · comisiones netas, en
//     `neg` si la red debe · vence en 30 días · vencidas y abiertas).
//   · DataTable → FinTable en las cinco pestañas. Días a vencer: `neg` si ya
//     venció y sigue abierta, `pend` si vence en ≤ 30 días (`daysLeftTone`).
//   · El aviso de espejo > 24 h es `Notice stale`; el error, `Notice bad`; el
//     badge «N excluidos (pruebas)» es `StatusBadge neutral`.
//   · Vencimientos: la proyección queda ROTULADA «proyección» en la columna y
//     con un `Notice info`; las franjas 30/60/90 días son acumuladas.
//   · Los totales de dinero sólo se muestran si todas las filas son de la
//     misma moneda (`singleCurrency`, reglas G3).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Landmark, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, kpiPlainText, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Segmented } from '@/components/ui/segmented';
import { Field, Input, Select } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/info-tip';
import { useToasts } from '@/components/ui/toast';
import { ActionButton } from '@/components/payment-orders/action-button';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { formatDate, formatDateTime } from '@/lib/dates';
import { downloadCSV } from '@/lib/csv-export';
import { moduleDisplayLabel } from '@/lib/modules';
import { useData } from '@/lib/data-context';
import { useReportDataFreshness } from '@/lib/data-freshness';
import { cn } from '@/lib/utils';
import { capitalRows, daysLeftTone, hfStatusKind, singleCurrency, sumKnown, type CapitalRow } from './hf-view';

// ── Tipos de la respuesta ────────────────────────────────────────────────────

interface Exclusion { total: number; testFund: number; testUser: number }

interface FundSummary {
  fundKey: string; name: string | null; status: string | null; enabled: boolean | null;
  risk: string | null; currency: string | null; approvalMode: string | null;
  profitsLocked: boolean | null; minInvestment: number | null; holdingMonths: number | null;
  expectedReturnRaw: string | null; aum: number; principal: number; clients: number;
  activeInvestments: number; totalInvestments: number; averageTicket: number | null;
  creditedReturns: number; lastPayoutAt: string | null; lastPayoutPercent: number | null;
}

interface CommissionTotals {
  paid: number; reversed: number; net: number; count: number; reversedCount: number;
}

interface Bucket { count: number; principal: number }

interface OverviewResponse {
  overview: {
    aum: number; clientLiability: number; liabilityPrincipal: number;
    liabilityCreditedReturns: number; clients: number; activeInvestments: number;
    totalInvestments: number; creditedReturns: number; commissions: CommissionTotals;
    maturities: { overdue: Bucket; in30: Bucket; in60: Bucket; in90: Bucket };
  };
  funds: FundSummary[];
  excluded: Exclusion;
  lastSyncedAt: string | null;
  stale: boolean | null;
}

interface InvestmentRow {
  investmentId: string; ref: string | null; userExternalId: string | null;
  client: { username: string | null; email: string | null; name: string | null } | null;
  fundKey: string | null; program: string | null; principal: number | null;
  balance: number | null; currency: string | null; startDate: string | null;
  endDate: string | null; daysLeft: number | null; status: string | null;
  certificate: { number: string | null; sentAt: string | null } | null;
}

interface InvestmentsResponse {
  investments: InvestmentRow[]; totalInMirror: number; withoutProfile: number;
  excluded: Exclusion; invalidDueBefore?: boolean;
}

interface MonthTotal { ym: string; amount: number; count: number }
interface ByMonth { months: MonthTotal[]; withoutDate: number; withoutDateAmount: number }

type PayoutRun = {
  payoutId: string; fundKey: string | null; program: string | null;
  percent: number | null; status: string | null; accountsAffected: number | null;
  totalCredited: number | null; currency: string | null; executedBy: string | null;
  at: string | null;
};
type CommissionRow = {
  commissionId: string; type: string | null; beneficiary: string | null;
  source: string | null; fundKey: string | null; level: number | null;
  percent: number | null; amount: number | null; currency: string | null;
  ym: string | null; status: string | null; at: string | null;
};

interface PaymentsResponse {
  returns: {
    runs: PayoutRun[];
    entries: Array<{ entryId: string; investmentId: string | null; userExternalId: string | null;
      fundKey: string | null; amount: number | null; currency: string | null;
      payoutId: string | null; description: string | null; at: string | null }>;
    total: number; byMonth: ByMonth;
  };
  commissions: {
    rows: CommissionRow[];
    totals: CommissionTotals; byMonth: ByMonth;
  };
  capital: {
    requests: Array<{ requestId: string; investmentId: string | null; fundKey: string | null;
      status: string | null; amount: number | null; currency: string | null; at: string | null }>;
    terminations: Array<{ entryId: string; investmentId: string | null; fundKey: string | null;
      amount: number | null; currency: string | null; at: string | null }>;
    total: number; byMonth: ByMonth;
  };
  otherLedgerTypes: string[];
  excluded: Exclusion;
}

type MaturityMonth = {
  ym: string; count: number; principal: number;
  projected: { min: number; max: number } | null; withoutProjection: number;
};
type ActualReturn = { fundKey: string; ym: string; percent: number | null; amount: number | null };

interface MaturitiesResponse {
  months: MaturityMonth[];
  buckets: { overdue: Bucket; in30: Bucket; in60: Bucket; in90: Bucket };
  activeWithoutEndDate: number;
  activeCount: number;
  actualMonthlyReturns: ActualReturn[];
  excluded: Exclusion;
}

type Tab = 'summary' | 'programs' | 'investments' | 'payments' | 'maturities';

// ── Helpers de presentación ──────────────────────────────────────────────────

/** `null` NUNCA se dibuja como 0. Ésta es la única puerta a «—». */
function Dash({ children, value }: { children: React.ReactNode; value: unknown }) {
  if (value === null || value === undefined) return <span className="text-text-3">—</span>;
  return <>{children}</>;
}

/** Monto en su moneda (las filas del CRM traen la suya). */
function Amount({ value, currency, tone, signed }: {
  value: number | null | undefined; currency?: string | null; tone?: 'auto' | 'neutral'; signed?: boolean;
}) {
  return <Money value={value} currency={currency ?? 'USD'} tone={tone} signed={signed} className="font-medium" />;
}

function Pct({ value }: { value: number | null | undefined }) {
  return <Dash value={value}><span className={NUM_CLASS}>{kpiPlainText(value, 'percent')}</span></Dash>;
}

function DateCell({ value }: { value: string | null | undefined }) {
  return <Dash value={value}><span className={cn(NUM_CLASS, 'text-text-2')}>{formatDate(value ?? '')}</span></Dash>;
}

function RawStatus({ status }: { status: string | null }) {
  if (!status) return <span className="text-text-3">—</span>;
  return <StatusBadge kind={hfStatusKind(status)} label={status} />;
}

function ExcludedBadge({ excluded, t }: { excluded: Exclusion | null; t: T }) {
  if (!excluded || excluded.total === 0) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <StatusBadge kind="neutral" label={t('hf.excluded', { count: String(excluded.total) })} />
      <InfoTip text={t('hf.excludedTip')} />
    </span>
  );
}

type T = (k: string, p?: Record<string, string>) => string;

// ── La pantalla ──────────────────────────────────────────────────────────────

export default function HedgeFundPage() {
  const { t } = useI18n();
  const { company } = useData();
  const canAccess = useModuleAccess('hedge_fund');
  const { toast, ToastHost } = useToasts();

  const [tab, setTab] = useState<Tab>('summary');
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  // Frescura de la topbar: el `synced_at` más reciente del espejo del CRM.
  useReportDataFreshness('hedge-fund:mirror', overview?.lastSyncedAt ?? null);
  const [investments, setInvestments] = useState<InvestmentsResponse | null>(null);
  const [payments, setPayments] = useState<PaymentsResponse | null>(null);
  const [maturities, setMaturities] = useState<MaturitiesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Filtros de la pestaña Inversiones.
  const [fundFilter, setFundFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dueBefore, setDueBefore] = useState('');

  const cargarOverview = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/hedge-fund/overview');
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? 'error');
      setOverview(json as OverviewResponse);
      setLoadError(null);
    } catch (err) {
      // El error se MUESTRA. Dejar la pantalla en cero sería indistinguible de
      // «esta empresa no tiene fondos».
      setLoadError(err instanceof Error ? err.message : 'error');
    }
  }, []);

  useEffect(() => {
    if (!canAccess) return;
    void cargarOverview();
  }, [canAccess, cargarOverview]);

  // La lista de inversiones se vuelve a pedir cuando cambian los filtros: el
  // servidor es el que sabe cuántas quedaron fuera y cuántas no tienen perfil.
  useEffect(() => {
    if (!canAccess || tab !== 'investments') return;
    const params = new URLSearchParams();
    if (fundFilter) params.set('fund', fundFilter);
    if (statusFilter) params.set('status', statusFilter);
    if (dueBefore) params.set('due_before', dueBefore);
    let cancelado = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/admin/hedge-fund/investments?${params.toString()}`);
        const json = await res.json();
        if (cancelado) return;
        if (!res.ok || !json.success) throw new Error(json.error ?? 'error');
        setInvestments(json as InvestmentsResponse);
      } catch (err) {
        if (!cancelado) setLoadError(err instanceof Error ? err.message : 'error');
      }
    })();
    return () => { cancelado = true; };
  }, [canAccess, tab, fundFilter, statusFilter, dueBefore]);

  useEffect(() => {
    if (!canAccess || tab !== 'payments' || payments) return;
    void (async () => {
      try {
        const res = await apiFetch('/api/admin/hedge-fund/payments');
        const json = await res.json();
        if (res.ok && json.success) setPayments(json as PaymentsResponse);
      } catch { /* el banner de error ya lo cubre el overview */ }
    })();
  }, [canAccess, tab, payments]);

  useEffect(() => {
    if (!canAccess || tab !== 'maturities' || maturities) return;
    void (async () => {
      try {
        const res = await apiFetch('/api/admin/hedge-fund/maturities');
        const json = await res.json();
        if (res.ok && json.success) setMaturities(json as MaturitiesResponse);
      } catch { /* idem */ }
    })();
  }, [canAccess, tab, maturities]);

  const sincronizar = async () => {
    setSyncing(true);
    try {
      const res = await apiFetch('/api/admin/hedge-fund/sync', { method: 'POST', timeoutMs: 120_000 });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? t('hf.syncFailed'));
      const r = json.result;
      toast.success(
        t('hf.syncDone', {
          funds: String(r.funds.upserted),
          investments: String(r.investments.upserted),
          commissions: String(r.commissions.upserted),
          excluded: String(r.excludedTotal),
          config: r.configChanged ? t('hf.syncConfigChanged') : t('hf.syncConfigSame'),
        }),
      );
      // Se vuelve a pedir TODO lo que estuviera cacheado: dejar la pantalla con
      // los números viejos después de un sync sería el peor momento posible
      // para mostrar un dato obsoleto.
      setInvestments(null); setPayments(null); setMaturities(null);
      await cargarOverview();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('hf.syncFailed'));
    } finally {
      setSyncing(false);
    }
  };

  const fondos = overview?.funds ?? [];
  const estados = useMemo(
    () => [...new Set((investments?.investments ?? []).map((i) => i.status).filter((s): s is string => !!s))].sort(),
    [investments],
  );

  if (!canAccess) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-[13px] text-text-2">403 · Acceso restringido</p>
      </div>
    );
  }

  const excluded = overview?.excluded ?? null;
  const overdueCount = overview?.overview.maturities.overdue.count ?? 0;

  return (
    <div className="space-y-4">
      {ToastHost}

      <PageHeader
        title={moduleDisplayLabel('hedge_fund', t('hf.title'), company)}
        subtitle={t('hf.subtitle')}
        icon={Landmark}
        actions={
          <>
            <ExcludedBadge excluded={excluded} t={t} />
            <ActionButton onClick={sincronizar} loading={syncing}>
              {!syncing && <RefreshCw aria-hidden className="size-[15px]" strokeWidth={1.75} />}
              {syncing ? t('hf.syncing') : t('hf.syncNow')}
            </ActionButton>
          </>
        }
      />

      {/* Estado del espejo. `null` = nunca se sincronizó, que NO es «viejo». */}
      {overview && (
        <p className="text-[12.5px] text-text-3" suppressHydrationWarning>
          {overview.lastSyncedAt
            ? t('hf.lastSync', { when: formatDateTime(overview.lastSyncedAt) })
            : t('hf.neverSynced')}
        </p>
      )}

      {overview?.stale === true && (
        <Notice kind="stale" title={t('hf.staleMirror')}>
          {overview.lastSyncedAt ? t('hf.lastSync', { when: formatDateTime(overview.lastSyncedAt) }) : null}
        </Notice>
      )}

      {loadError && <Notice kind="bad" title={t('hf.lm.loadError')}>{loadError}</Notice>}

      <div className="max-w-full overflow-x-auto">
        <Segmented<Tab>
          aria-label={t('hf.title')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'summary', label: t('hf.tab.summary') },
            { value: 'programs', label: t('hf.tab.programs'), count: overview ? fondos.length : null },
            { value: 'investments', label: t('hf.tab.investments'), count: overview?.overview.activeInvestments ?? null },
            { value: 'payments', label: t('hf.tab.payments') },
            {
              value: 'maturities',
              // Vencidas y abiertas: el único conteo de las pestañas que pide
              // acción ya. Va en `neg` y con texto, no sólo color.
              label: overdueCount > 0 ? (
                <span className="inline-flex items-center gap-1.5">
                  {t('hf.tab.maturities')}
                  <span className={cn(NUM_CLASS, 'text-neg')}>{t('hf.lm.overdueTab', { count: String(overdueCount) })}</span>
                </span>
              ) : t('hf.tab.maturities'),
              count: overview?.overview.maturities.in30.count ?? null,
            },
          ]}
        />
      </div>

      {!overview && !loadError && <Skeleton className="h-40" />}

      {overview && tab === 'summary' && <Resumen data={overview} t={t} />}
      {overview && tab === 'programs' && (
        <Panel title={t('hf.tab.programs')} hint={t('hf.lm.programsHint')} flush>
          <TablaProgramas funds={fondos} t={t} onPick={(k) => { setFundFilter(k); setTab('investments'); }} />
        </Panel>
      )}
      {tab === 'investments' && (
        <Inversiones
          data={investments} funds={fondos} statuses={estados} t={t}
          fundFilter={fundFilter} setFundFilter={setFundFilter}
          statusFilter={statusFilter} setStatusFilter={setStatusFilter}
          dueBefore={dueBefore} setDueBefore={setDueBefore}
        />
      )}
      {tab === 'payments' && <Pagos data={payments} t={t} />}
      {tab === 'maturities' && <Vencimientos data={maturities} t={t} />}
    </div>
  );
}

// ── Resumen ──────────────────────────────────────────────────────────────────

function Resumen({ data, t }: { data: OverviewResponse; t: T }) {
  const o = data.overview;
  const capital: KpiItem[] = [
    { key: 'aum', label: t('hf.aum'), value: o.aum, hero: true, sub: t('hf.aumHint') },
    {
      key: 'liability',
      label: t('hf.liability'),
      value: o.clientLiability,
      sub: t('hf.liabilityHint', { principal: formatMoney(o.liabilityPrincipal), returns: formatMoney(o.liabilityCreditedReturns) }),
    },
    { key: 'clients', label: t('hf.clients'), value: o.clients, format: 'count' },
    {
      key: 'active',
      label: t('hf.activeInvestments'),
      value: o.activeInvestments,
      format: 'count',
      sub: t('hf.lm.ofTotal', { total: String(o.totalInvestments) }),
    },
  ];
  const flows: KpiItem[] = [
    { key: 'returns', label: t('hf.creditedReturns'), value: o.creditedReturns, sub: t('hf.creditedReturnsHint') },
    {
      key: 'commissions',
      label: t('hf.netCommissions'),
      value: o.commissions.net,
      // Un neto negativo es DEUDA de la red, no un cero: `auto` lo pinta `neg`.
      tone: 'auto',
      sub: t('hf.netCommissionsHint', { paid: formatMoney(o.commissions.paid), reversed: formatMoney(o.commissions.reversed) }),
    },
    {
      key: 'in30',
      label: t('hf.maturing30'),
      value: o.maturities.in30.principal,
      sub: t('hf.maturingHint', { count: String(o.maturities.in30.count) }),
    },
    {
      key: 'overdue',
      label: t('hf.overdue'),
      value: o.maturities.overdue.principal,
      tone: o.maturities.overdue.count > 0 ? 'neg' : 'neutral',
      sub: t('hf.maturingHint', { count: String(o.maturities.overdue.count) }),
    },
  ];
  return (
    <div className="space-y-4">
      <KpiStrip items={capital} />
      <KpiStrip items={flows} />
      <Panel title={t('hf.byProgram')} flush>
        <TablaProgramas funds={data.funds} t={t} />
      </Panel>
    </div>
  );
}

// ── Programas ────────────────────────────────────────────────────────────────

function FundStatus({ f, t }: { f: FundSummary; t: T }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <RawStatus status={f.status} />
      {/* Los cinco fondos de Vex Pro están deshabilitados y la empresa SÍ
          ofrece el producto: se muestra con badge, no se esconde. */}
      {f.enabled === false && <StatusBadge kind="pend" label={t('hf.disabled')} />}
    </span>
  );
}

function TablaProgramas({ funds, t, onPick }: { funds: FundSummary[]; t: T; onPick?: (k: string) => void }) {
  const cols: FinColumn<FundSummary>[] = [
    {
      key: 'program',
      header: t('hf.colProgram'),
      cell: (f) => (onPick ? (
        <button type="button" onClick={() => onPick(f.fundKey)} className="text-left font-medium hover:underline">
          {f.name ?? f.fundKey}
        </button>
      ) : (
        <span className="font-medium">{f.name ?? f.fundKey}</span>
      )),
      meta: (f) => <span className="font-mono text-[12px]">{f.fundKey}</span>,
      mobileMeta: (f) => <FundStatus f={f} t={t} />,
    },
    { key: 'status', header: t('hf.colStatus'), cell: (f) => <FundStatus f={f} t={t} />, hideSm: true },
    { key: 'risk', header: t('hf.colRisk'), cell: (f) => f.risk ?? <Dash value={null}>{null}</Dash>, hideSm: true },
    {
      key: 'min', header: t('hf.colMinInvestment'), kind: 'money', value: (f) => f.minInvestment,
      cell: (f) => <Amount value={f.minInvestment} currency={f.currency} />, hideSm: true, subtotal: false,
    },
    {
      key: 'holding', header: t('hf.colHolding'), align: 'right', hideSm: true,
      cell: (f) => <Dash value={f.holdingMonths}><span className={NUM_CLASS}>{t('hf.months', { count: String(f.holdingMonths) })}</span></Dash>,
    },
    {
      // El texto CRUDO del CRM: es lo que el cliente firmó. El rango parseado
      // sólo se usa para proyectar, nunca para reescribir esta celda.
      key: 'expected', header: t('hf.colExpectedReturn'), hideSm: true,
      cell: (f) => <Dash value={f.expectedReturnRaw}>{f.expectedReturnRaw}</Dash>,
    },
    { key: 'approval', header: t('hf.colApproval'), cell: (f) => f.approvalMode ?? <Dash value={null}>{null}</Dash>, hideSm: true },
    {
      key: 'locked', header: t('hf.colProfitsLocked'), hideSm: true,
      cell: (f) => <Dash value={f.profitsLocked}>{f.profitsLocked ? '✓' : '—'}</Dash>,
    },
    {
      key: 'aum', header: t('hf.colAum'), kind: 'money', value: (f) => f.aum,
      cell: (f) => <Amount value={f.aum} currency={f.currency} />, subtotal: false,
    },
    { key: 'clients', header: t('hf.colClients'), kind: 'number', value: (f) => f.clients, hideSm: true },
    {
      // `null` cuando no hay ninguna inversión activa: un 0 diría «el ticket es
      // cero», que es otra afirmación.
      key: 'ticket', header: t('hf.colAvgTicket'), kind: 'money', value: (f) => f.averageTicket,
      cell: (f) => <Amount value={f.averageTicket} currency={f.currency} />, hideSm: true, subtotal: false,
    },
    {
      key: 'lastPayout', header: t('hf.colLastPayout'), align: 'right', hideSm: true,
      cell: (f) => (
        <Dash value={f.lastPayoutAt}>
          <span className={cn(NUM_CLASS, 'block text-text-2')}>{formatDate(f.lastPayoutAt ?? '')}</span>
          {f.lastPayoutPercent !== null && (
            <span className={cn(NUM_CLASS, 'block text-[12px] text-text-3')}>{kpiPlainText(f.lastPayoutPercent, 'percent')}</span>
          )}
        </Dash>
      ),
    },
  ];
  return (
    <FinTable
      caption={t('hf.byProgram')}
      columns={cols}
      rows={funds}
      rowKey={(f) => f.fundKey}
      empty={t('hf.noData')}
    />
  );
}

// ── Inversiones ──────────────────────────────────────────────────────────────

function Inversiones(props: {
  data: InvestmentsResponse | null; funds: FundSummary[]; statuses: string[]; t: T;
  fundFilter: string; setFundFilter: (v: string) => void;
  statusFilter: string; setStatusFilter: (v: string) => void;
  dueBefore: string; setDueBefore: (v: string) => void;
}) {
  const { data, funds, statuses, t } = props;
  const rows = data?.investments ?? [];
  const currency = singleCurrency(rows);

  const exportar = () => {
    downloadCSV(
      `hedge-fund-inversiones-${new Date().toISOString().slice(0, 10)}.csv`,
      ['ref', 'cliente', 'email', 'programa', 'principal', 'saldo', 'inicio', 'vencimiento', 'dias', 'estado', 'certificado'],
      rows.map((r) => [
        r.ref ?? '', r.client?.name ?? r.client?.username ?? '', r.client?.email ?? '',
        r.program ?? r.fundKey ?? '', r.principal ?? '', r.balance ?? '',
        r.startDate ?? '', r.endDate ?? '', r.daysLeft ?? '', r.status ?? '',
        r.certificate?.number ?? '',
      ]),
    );
  };

  const cols: FinColumn<InvestmentRow>[] = [
    {
      key: 'client',
      header: t('hf.colClient'),
      // Un perfil que no cruzó NO borra la fila ni la disfraza: se muestra el
      // id crudo para que el cruce roto se pueda ver y arreglar.
      cell: (r) => (r.client
        ? <span className="font-medium">{r.client.name ?? r.client.username ?? r.userExternalId}</span>
        : <span className="font-mono text-[12px]">{r.userExternalId ?? '—'}</span>),
      meta: (r) => (r.client
        ? r.client.email ?? undefined
        : <StatusBadge kind="pend" label={t('hf.lm.noProfile')} />),
      mobileMeta: (r) => (
        <>
          <RawStatus status={r.status} />
          <DaysLeft value={r.daysLeft} t={t} />
        </>
      ),
    },
    {
      key: 'ref', header: t('hf.colRef'), hideSm: true,
      cell: (r) => <span className="font-mono text-[12px] text-text-2">{r.ref ?? r.investmentId.slice(0, 8)}</span>,
    },
    { key: 'program', header: t('hf.colProgram'), cell: (r) => r.program ?? r.fundKey ?? '—', hideSm: true },
    {
      key: 'principal', header: t('hf.colPrincipal'), kind: 'money', value: (r) => r.principal,
      cell: (r) => <Amount value={r.principal} currency={r.currency} />, hideSm: true,
      money: { currency: currency ?? 'USD' },
    },
    {
      key: 'balance', header: t('hf.colBalance'), kind: 'money', value: (r) => r.balance,
      cell: (r) => <Amount value={r.balance} currency={r.currency} />,
      money: { currency: currency ?? 'USD' },
    },
    { key: 'start', header: t('hf.colStart'), cell: (r) => <DateCell value={r.startDate} />, hideSm: true },
    { key: 'end', header: t('hf.colEnd'), cell: (r) => <DateCell value={r.endDate} />, hideSm: true },
    {
      key: 'days', header: t('hf.colDaysLeft'), align: 'right', hideSm: true,
      // Negativo = ya venció y sigue abierta (`neg`); ≤ 30 = vence pronto (`pend`).
      cell: (r) => <DaysLeft value={r.daysLeft} t={t} />,
    },
    { key: 'status', header: t('hf.colStatus'), cell: (r) => <RawStatus status={r.status} />, hideSm: true },
    {
      key: 'cert', header: t('hf.colCertificate'), hideSm: true,
      cell: (r) => <Dash value={r.certificate}><span className="font-mono text-[12px]">{r.certificate?.number}</span></Dash>,
    },
  ];

  const filtered = data !== null && rows.length < data.totalInMirror;

  return (
    <Panel
      title={t('hf.tab.investments')}
      hint={data ? t('hf.lm.investmentsHint', { shown: String(rows.length), total: String(data.totalInMirror) }) : undefined}
      actions={
        <>
          <ExcludedBadge excluded={data?.excluded ?? null} t={t} />
          <ActionButton onClick={exportar} disabled={rows.length === 0}>
            <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
            {t('hf.exportCsv')}
          </ActionButton>
        </>
      }
      flush
      footer={filtered ? t('hf.lm.filteredFooter', { shown: String(rows.length), total: String(data!.totalInMirror) }) : undefined}
    >
      <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
        <Field label={t('hf.filterFund')} className="w-full sm:w-52">
          <Select value={props.fundFilter} onChange={(e) => props.setFundFilter(e.target.value)}>
            <option value="">{t('hf.filterAll')}</option>
            {funds.map((f) => <option key={f.fundKey} value={f.fundKey}>{f.name ?? f.fundKey}</option>)}
          </Select>
        </Field>
        <Field label={t('hf.filterStatus')} className="w-full sm:w-44">
          <Select value={props.statusFilter} onChange={(e) => props.setStatusFilter(e.target.value)}>
            <option value="">{t('hf.filterAll')}</option>
            {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Field
          label={t('hf.filterDueBefore')}
          className="w-full sm:w-44"
          error={data?.invalidDueBefore ? t('hf.lm.invalidDate') : undefined}
        >
          <Input type="date" value={props.dueBefore} onChange={(e) => props.setDueBefore(e.target.value)} />
        </Field>
      </div>

      {/* Un cruce que no encontró perfil se CUENTA y se dice. */}
      {(data?.withoutProfile ?? 0) > 0 && (
        <div className="border-b border-border px-4 py-3">
          <Notice kind="pend" title={t('hf.lm.withoutProfile', { count: String(data!.withoutProfile), total: String(rows.length) })}>
            {t('hf.lm.withoutProfileBody')}
          </Notice>
        </div>
      )}

      {data === null ? (
        <div className="p-4"><Skeleton className="h-40" /></div>
      ) : (
        <FinTable
          caption={t('hf.tab.investments')}
          columns={cols}
          rows={rows}
          rowKey={(r) => r.investmentId}
          empty={t('hf.noInvestments')}
          footer={
            rows.length > 0
              ? currency
                ? {
                    label: t('hf.lm.totalRows', { count: String(rows.length) }),
                    values: { principal: sumKnown(rows.map((r) => r.principal)), balance: sumKnown(rows.map((r) => r.balance)) },
                  }
                : { label: t('hf.lm.mixedCurrencies') }
              : undefined
          }
        />
      )}
    </Panel>
  );
}

function DaysLeft({ value, t }: { value: number | null; t: T }) {
  const tone = daysLeftTone(value);
  if (value === null) return <span className="text-text-3">—</span>;
  return (
    <span
      className={cn(NUM_CLASS, tone === 'neg' && 'font-medium text-neg', tone === 'pend' && 'font-medium text-pend')}
      title={tone === 'neg' ? t('hf.lm.overdueTip') : tone === 'pend' ? t('hf.lm.soonTip') : undefined}
    >
      {t('hf.lm.days', { count: String(value) })}
    </span>
  );
}

// ── Pagos ────────────────────────────────────────────────────────────────────

/** Totales por mes en el pie del panel. Un importe sin fecha NO se cuelga de un mes inventado: se dice aparte. */
function TotalesPorMes({ data, t }: { data: ByMonth; t: T }) {
  if (data.months.length === 0 && data.withoutDate === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>{t('hf.lm.byMonth')}</span>
      {data.months.map((m) => (
        <span key={m.ym} className={NUM_CLASS}>
          {m.ym}{' '}
          <Money value={m.amount} className="font-medium text-foreground" />{' '}
          <span>({m.count})</span>
        </span>
      ))}
      {data.withoutDate > 0 && (
        <StatusBadge
          kind="pend"
          label={t('hf.lm.withoutDate', { count: String(data.withoutDate), amount: formatMoney(data.withoutDateAmount) })}
        />
      )}
    </div>
  );
}

function Pagos({ data, t }: { data: PaymentsResponse | null; t: T }) {
  if (!data) return <Skeleton className="h-60" />;

  const runCols: FinColumn<PayoutRun>[] = [
    {
      // El programa primero: la etiqueta del total del pie cae en esta columna.
      key: 'program', header: t('hf.colProgram'), cell: (r) => r.program ?? r.fundKey ?? '—',
      mobileMeta: (r) => (
        <>
          <DateCell value={r.at} />
          <RawStatus status={r.status} />
        </>
      ),
    },
    { key: 'date', header: t('hf.colDate'), cell: (r) => <DateCell value={r.at} />, hideSm: true },
    { key: 'percent', header: t('hf.colPercent'), align: 'right', cell: (r) => <Pct value={r.percent} />, hideSm: true },
    { key: 'accounts', header: t('hf.colAccounts'), kind: 'number', value: (r) => r.accountsAffected, hideSm: true },
    {
      key: 'amount', header: t('hf.colAmount'), kind: 'money', value: (r) => r.totalCredited,
      cell: (r) => <Amount value={r.totalCredited} currency={r.currency} />, subtotal: false,
    },
    { key: 'status', header: t('hf.colStatus'), cell: (r) => <RawStatus status={r.status} />, hideSm: true },
  ];

  const commissionCols: FinColumn<CommissionRow>[] = [
    {
      key: 'beneficiary', header: t('hf.colBeneficiary'), cell: (r) => r.beneficiary ?? '—',
      meta: (r) => [r.type, r.source].filter(Boolean).join(' · ') || undefined,
      mobileMeta: (r) => <DateCell value={r.at} />,
    },
    { key: 'date', header: t('hf.colDate'), cell: (r) => <DateCell value={r.at} />, hideSm: true },
    { key: 'level', header: t('hf.colLevel'), kind: 'number', value: (r) => r.level, hideSm: true },
    { key: 'percent', header: t('hf.colPercent'), align: 'right', cell: (r) => <Pct value={r.percent} />, hideSm: true },
    { key: 'month', header: t('hf.colMonth'), cell: (r) => <span className={NUM_CLASS}>{r.ym ?? '—'}</span>, hideSm: true },
    {
      // Sin clamp a 0: un reverso es negativo y se ve en `neg` (§2.1 #1).
      key: 'amount', header: t('hf.colAmount'), kind: 'money', value: (r) => r.amount,
      cell: (r) => <Amount value={r.amount} currency={r.currency} tone="auto" />, subtotal: false,
    },
  ];

  const capRows = capitalRows(data.capital);
  const capitalCols: FinColumn<CapitalRow>[] = [
    {
      key: 'kind', header: t('hf.colType'),
      cell: (r) => (r.kind === 'request' ? t('hf.lm.capitalRequest') : t('hf.lm.capitalTermination')),
      meta: (r) => r.fundKey ?? undefined,
      mobileMeta: (r) => <DateCell value={r.at} />,
    },
    { key: 'date', header: t('hf.colDate'), cell: (r) => <DateCell value={r.at} />, hideSm: true },
    {
      key: 'amount', header: t('hf.colAmount'), kind: 'money', value: (r) => r.amount,
      cell: (r) => <Amount value={r.amount} currency={r.currency} />, subtotal: false,
    },
    { key: 'status', header: t('hf.colStatus'), cell: (r) => <RawStatus status={r.status} />, hideSm: true },
  ];

  return (
    <div className="space-y-4">
      {/* (a) Rendimientos */}
      <Panel
        title={t('hf.payoutsBlock')}
        hint={t('hf.payoutsBlockHint')}
        flush
        footer={<TotalesPorMes data={data.returns.byMonth} t={t} />}
      >
        <FinTable
          caption={t('hf.payoutsBlock')}
          columns={runCols}
          rows={data.returns.runs}
          rowKey={(r) => r.payoutId}
          empty={t('hf.noPayouts')}
          footer={
            data.returns.runs.length > 0 || data.returns.total !== 0
              ? { label: t('hf.lm.returnsTotal', { count: String(data.returns.entries.length) }), values: { amount: data.returns.total } }
              : undefined
          }
        />
      </Panel>

      {/* (b) Comisiones — con los reversos a la vista */}
      <Panel
        title={t('hf.commissionsBlock')}
        hint={t('hf.commissionsBlockHint')}
        flush
        footer={<TotalesPorMes data={data.commissions.byMonth} t={t} />}
      >
        <FinTable
          caption={t('hf.commissionsBlock')}
          columns={commissionCols}
          rows={data.commissions.rows}
          rowKey={(r) => r.commissionId}
          empty={t('hf.noCommissions')}
          footerRows={[
            { label: t('hf.lm.commissionsPaid', { count: String(data.commissions.totals.count) }), values: { amount: data.commissions.totals.paid } },
            { label: t('hf.lm.commissionsReversed', { count: String(data.commissions.totals.reversedCount) }), values: { amount: -data.commissions.totals.reversed } },
          ]}
          // Sin clamp a 0: un neto negativo ES deuda de la red (§2.1 #1).
          footer={{ label: t('hf.lm.commissionsNet'), values: { amount: data.commissions.totals.net } }}
        />
      </Panel>

      {/* (c) Capital devuelto y solicitudes */}
      <Panel
        title={t('hf.capitalBlock')}
        hint={t('hf.capitalBlockHint')}
        flush
        footer={<TotalesPorMes data={data.capital.byMonth} t={t} />}
      >
        <FinTable
          caption={t('hf.capitalBlock')}
          columns={capitalCols}
          rows={capRows}
          rowKey={(r) => `${r.kind}:${r.id}`}
          empty={t('hf.noCapitalReturns')}
          footer={
            capRows.length > 0
              ? {
                  // El total es de los asientos TERMINATION (capital que ya
                  // salió); las solicitudes todavía no son plata devuelta.
                  label: t('hf.lm.capitalTotal', { count: String(data.capital.terminations.length) }),
                  values: { amount: data.capital.total },
                }
              : undefined
          }
        />
      </Panel>

      {/* Un tipo de asiento que no cae en ninguno de los tres bloques APARECE.
          Callarlo lo haría desaparecer del módulo sin dejar rastro. */}
      {data.otherLedgerTypes.length > 0 && (
        <Notice kind="pend" title={t('hf.lm.otherLedgerTypes', { types: data.otherLedgerTypes.join(', ') })}>
          {t('hf.lm.otherLedgerTypesBody')}
        </Notice>
      )}
    </div>
  );
}

// ── Vencimientos ─────────────────────────────────────────────────────────────

function Vencimientos({ data, t }: { data: MaturitiesResponse | null; t: T }) {
  if (!data) return <Skeleton className="h-60" />;
  const b = data.buckets;
  const buckets: KpiItem[] = [
    {
      key: 'overdue', label: t('hf.overdue'), value: b.overdue.principal,
      tone: b.overdue.count > 0 ? 'neg' : 'neutral',
      sub: t('hf.maturingHint', { count: String(b.overdue.count) }),
    },
    { key: 'in30', label: t('hf.maturing30'), value: b.in30.principal, hero: true, sub: t('hf.maturingHint', { count: String(b.in30.count) }) },
    { key: 'in60', label: t('hf.lm.maturing60'), value: b.in60.principal, sub: t('hf.lm.cumulativeHint', { count: String(b.in60.count) }) },
    { key: 'in90', label: t('hf.lm.maturing90'), value: b.in90.principal, sub: t('hf.lm.cumulativeHint', { count: String(b.in90.count) }) },
  ];

  const monthCols: FinColumn<MaturityMonth>[] = [
    { key: 'ym', header: t('hf.colMonth'), cell: (m) => <span className={cn(NUM_CLASS, 'font-medium')}>{m.ym}</span> },
    { key: 'count', header: t('hf.colCount'), kind: 'number', value: (m) => m.count, hideSm: true },
    { key: 'principal', header: t('hf.colPrincipal'), kind: 'money', value: (m) => m.principal },
    {
      key: 'projected',
      header: t('hf.lm.colProjection'),
      align: 'right',
      // `null` = ninguna inversión del mes se pudo proyectar. «—», nunca 0: un
      // 0 se leería como «ese mes no rinde nada».
      cell: (m) => (
        <Dash value={m.projected}>
          <span className={cn(NUM_CLASS, 'text-text-2')}>
            <Money value={m.projected?.min} tone="neutral" /> – <Money value={m.projected?.max} tone="neutral" />
          </span>
          {m.withoutProjection > 0 && (
            <span className="block text-[12px] text-pend">
              {t('hf.projectionMissing', { count: String(m.withoutProjection) })}
            </span>
          )}
        </Dash>
      ),
      hideSm: true,
    },
  ];

  const actualCols: FinColumn<ActualReturn>[] = [
    { key: 'ym', header: t('hf.colMonth'), cell: (r) => <span className={NUM_CLASS}>{r.ym}</span> },
    { key: 'fund', header: t('hf.colProgram'), cell: (r) => r.fundKey },
    { key: 'percent', header: t('hf.colPercent'), align: 'right', cell: (r) => <Pct value={r.percent} /> },
    { key: 'amount', header: t('hf.colAmount'), kind: 'money', value: (r) => r.amount, subtotal: false },
  ];

  const principalTotal = sumKnown(data.months.map((m) => m.principal));

  return (
    <div className="space-y-4">
      <KpiStrip items={buckets} />

      <Notice kind="info" title={t('hf.projectionWarning')} />

      {/* Capital activo SIN fecha de fin: no entra a ningún mes, así que hay
          que decirlo o desaparece del calendario en silencio. */}
      {data.activeWithoutEndDate > 0 && (
        <Notice
          kind="pend"
          title={t('hf.lm.withoutEndDate', { count: String(data.activeWithoutEndDate), total: String(data.activeCount) })}
        >
          {t('hf.lm.withoutEndDateBody')}
        </Notice>
      )}

      <Panel title={t('hf.maturitiesTitle')} hint={t('hf.lm.maturitiesHint')} flush>
        <FinTable
          caption={t('hf.maturitiesTitle')}
          columns={monthCols}
          rows={data.months}
          rowKey={(m) => m.ym}
          empty={t('hf.noMaturities')}
          footer={
            data.months.length > 0
              ? { label: t('hf.lm.maturitiesTotal', { count: String(data.months.reduce((s, m) => s + m.count, 0)) }), values: { principal: principalTotal } }
              : undefined
          }
        />
      </Panel>

      {/* El rendimiento REAL del mes, cuando el CRM lo tenga. Hoy la colección
          está vacía en las dos empresas: se dice «sin datos», no 0%. */}
      <Panel title={t('hf.lm.actualTitle')} hint={t('hf.lm.actualHint')} flush>
        <FinTable
          caption={t('hf.lm.actualTitle')}
          columns={actualCols}
          rows={data.actualMonthlyReturns}
          rowKey={(r) => `${r.fundKey}:${r.ym}`}
          empty={t('hf.noData')}
        />
      </Panel>
    </div>
  );
}
