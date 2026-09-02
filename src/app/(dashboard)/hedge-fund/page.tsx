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
// ── EL TÍTULO ES 'Hedge Fund' EN LAS DOS EMPRESAS ──────────────────────────
// Kevin pidió que Vex Pro pudiera verlo como «Vex Capital». NO se implementó y
// NO se agregó una columna para eso: `companies` no tiene ningún jsonb de
// settings donde meterlo (verificado contra schema.sql y las 124 migraciones el
// 2026-09-02), y crear una columna para un rótulo es una decisión de esquema
// que merece su propia migración y su propio pedido. Queda anotado en el
// reporte de la tanda.
//
// ── LA CARGA ES POR PESTAÑA ────────────────────────────────────────────────
// El Resumen y los Programas salen de la MISMA llamada (`/overview`): son la
// misma consulta y partirla daría dos números que pueden separarse. Las otras
// tres se piden al abrirlas y se cachean en memoria — abrir Pagos no debería
// costar el calendario de vencimientos.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Banknote, CalendarClock, Download, Landmark, RefreshCw,
  TrendingUp, Users, Wallet,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionTabs } from '@/components/ui/section-tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/info-tip';
import { useToasts } from '@/components/ui/toast';
import { useModuleAccess } from '@/lib/use-module-access';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { formatCurrency } from '@/lib/utils';
import { formatDate, formatDateTime } from '@/lib/dates';
import { downloadCSV } from '@/lib/csv-export';

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
  excluded: Exclusion;
}

interface MonthTotal { ym: string; amount: number; count: number }
interface ByMonth { months: MonthTotal[]; withoutDate: number; withoutDateAmount: number }

interface PaymentsResponse {
  returns: {
    runs: Array<{ payoutId: string; fundKey: string | null; program: string | null;
      percent: number | null; status: string | null; accountsAffected: number | null;
      totalCredited: number | null; currency: string | null; executedBy: string | null;
      at: string | null }>;
    entries: Array<{ entryId: string; investmentId: string | null; userExternalId: string | null;
      fundKey: string | null; amount: number | null; currency: string | null;
      payoutId: string | null; description: string | null; at: string | null }>;
    total: number; byMonth: ByMonth;
  };
  commissions: {
    rows: Array<{ commissionId: string; type: string | null; beneficiary: string | null;
      source: string | null; fundKey: string | null; level: number | null;
      percent: number | null; amount: number | null; currency: string | null;
      ym: string | null; status: string | null; at: string | null }>;
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

interface MaturitiesResponse {
  months: Array<{ ym: string; count: number; principal: number;
    projected: { min: number; max: number } | null; withoutProjection: number }>;
  buckets: { overdue: Bucket; in30: Bucket; in60: Bucket; in90: Bucket };
  activeWithoutEndDate: number;
  activeCount: number;
  actualMonthlyReturns: Array<{ fundKey: string; ym: string; percent: number | null; amount: number | null }>;
  excluded: Exclusion;
}

type Tab = 'summary' | 'programs' | 'investments' | 'payments' | 'maturities';

// ── Helpers de presentación ──────────────────────────────────────────────────

const money = (v: number | null | undefined, currency = 'USD') =>
  v === null || v === undefined ? '—' : formatCurrency(v, currency);

/** `null` NUNCA se dibuja como 0. Ésta es la única puerta a «—». */
function Dash({ children, value }: { children: React.ReactNode; value: unknown }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  return <>{children}</>;
}

function ExcludedBadge({ excluded, t }: { excluded: Exclusion | null; t: (k: string, p?: Record<string, string>) => string }) {
  if (!excluded || excluded.total === 0) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="neutral">{t('hf.excluded', { count: String(excluded.total) })}</Badge>
      <InfoTip text={t('hf.excludedTip')} />
    </span>
  );
}

// ── La pantalla ──────────────────────────────────────────────────────────────

export default function HedgeFundPage() {
  const { t } = useI18n();
  const canAccess = useModuleAccess('hedge_fund');
  const { toast, ToastHost } = useToasts();

  const [tab, setTab] = useState<Tab>('summary');
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
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
        <p className="text-muted-foreground text-sm">403 · Acceso restringido</p>
      </div>
    );
  }

  const excluded = overview?.excluded ?? null;

  return (
    <div className="space-y-6">
      {ToastHost}

      <PageHeader
        title={t('hf.title')}
        subtitle={t('hf.subtitle')}
        icon={Landmark}
        actions={
          <>
            <ExcludedBadge excluded={excluded} t={t} />
            <Button variant="secondary" onClick={sincronizar} loading={syncing}>
              <RefreshCw className="w-4 h-4" />
              {syncing ? t('hf.syncing') : t('hf.syncNow')}
            </Button>
          </>
        }
      />

      {/* Estado del espejo. `null` = nunca se sincronizó, que NO es «viejo». */}
      <p className="text-xs text-muted-foreground">
        {overview?.lastSyncedAt
          ? t('hf.lastSync', { when: formatDateTime(overview.lastSyncedAt) })
          : overview
            ? t('hf.neverSynced')
            : ''}
      </p>

      {overview?.stale === true && (
        <Card className="border-warning/40 bg-warning/5">
          <p className="text-sm text-warning flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {t('hf.staleMirror')}
          </p>
        </Card>
      )}

      {loadError && (
        <Card className="border-negative/40 bg-negative/5">
          <p className="text-sm text-negative flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {loadError}
          </p>
        </Card>
      )}

      <SectionTabs<Tab>
        label={t('hf.title')}
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'summary', label: t('hf.tab.summary'), count: null },
          { value: 'programs', label: t('hf.tab.programs'), count: fondos.length },
          { value: 'investments', label: t('hf.tab.investments'), count: overview?.overview.activeInvestments ?? null },
          { value: 'payments', label: t('hf.tab.payments'), count: null },
          {
            value: 'maturities',
            label: t('hf.tab.maturities'),
            count: overview?.overview.maturities.in30.count ?? null,
            tone: (overview?.overview.maturities.overdue.count ?? 0) > 0 ? 'negative' : 'default',
          },
        ]}
      />

      {!overview && !loadError && <Skeleton className="h-40" />}

      {overview && tab === 'summary' && <Resumen data={overview} t={t} />}
      {overview && tab === 'programs' && <Programas funds={fondos} t={t} onPick={(k) => { setFundFilter(k); setTab('investments'); }} />}
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

type T = (k: string, p?: Record<string, string>) => string;

// ── Resumen ──────────────────────────────────────────────────────────────────

function Resumen({ data, t }: { data: OverviewResponse; t: T }) {
  const o = data.overview;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label={t('hf.aum')} value={money(o.aum)} hint={t('hf.aumHint')}
          icon={Landmark} tone="primary" emphasis
        />
        <StatCard
          label={t('hf.liability')} value={money(o.clientLiability)}
          hint={t('hf.liabilityHint', {
            principal: money(o.liabilityPrincipal),
            returns: money(o.liabilityCreditedReturns),
          })}
          icon={Wallet} tone="warning"
        />
        <StatCard label={t('hf.clients')} value={o.clients} icon={Users} />
        <StatCard label={t('hf.activeInvestments')} value={o.activeInvestments} icon={TrendingUp} />
        <StatCard
          label={t('hf.creditedReturns')} value={money(o.creditedReturns)}
          hint={t('hf.creditedReturnsHint')} icon={Banknote} tone="positive"
        />
        <StatCard
          label={t('hf.netCommissions')} value={money(o.commissions.net)}
          hint={t('hf.netCommissionsHint', {
            paid: money(o.commissions.paid),
            reversed: money(o.commissions.reversed),
          })}
          icon={Banknote}
          // Un neto negativo es DEUDA de la red, no un cero. Se colorea.
          tone={o.commissions.net < 0 ? 'negative' : 'neutral'}
        />
        <StatCard
          label={t('hf.maturing30')} value={money(o.maturities.in30.principal)}
          hint={t('hf.maturingHint', { count: String(o.maturities.in30.count) })}
          icon={CalendarClock} tone="info"
        />
        <StatCard
          label={t('hf.overdue')} value={money(o.maturities.overdue.principal)}
          hint={t('hf.maturingHint', { count: String(o.maturities.overdue.count) })}
          icon={AlertTriangle}
          tone={o.maturities.overdue.count > 0 ? 'negative' : 'neutral'}
        />
      </div>

      <Card>
        <h2 className="font-semibold mb-4">{t('hf.byProgram')}</h2>
        <TablaProgramas funds={data.funds} t={t} />
      </Card>
    </div>
  );
}

// ── Programas ────────────────────────────────────────────────────────────────

function TablaProgramas({ funds, t, onPick }: { funds: FundSummary[]; t: T; onPick?: (k: string) => void }) {
  const cols: Column<FundSummary>[] = [
    {
      header: t('hf.colProgram'),
      accessor: (f) => (
        <button
          type="button"
          onClick={() => onPick?.(f.fundKey)}
          className={onPick ? 'text-left hover:underline' : 'text-left cursor-default'}
          disabled={!onPick}
        >
          <span className="font-medium">{f.name ?? f.fundKey}</span>
          <span className="block text-xs text-muted-foreground">{f.fundKey}</span>
        </button>
      ),
    },
    {
      header: t('hf.colStatus'),
      accessor: (f) => (
        <span className="flex flex-wrap items-center gap-1">
          <Badge variant={f.status === 'OPEN' ? 'success' : 'neutral'}>{f.status ?? '—'}</Badge>
          {/* Los cinco fondos de Vex Pro están deshabilitados y la empresa SÍ
              ofrece el producto: se muestra con badge, no se esconde. */}
          {f.enabled === false && <Badge variant="warning">{t('hf.disabled')}</Badge>}
        </span>
      ),
    },
    { header: t('hf.colRisk'), accessor: (f) => f.risk ?? '—' },
    { header: t('hf.colMinInvestment'), align: 'right', accessor: (f) => money(f.minInvestment, f.currency ?? 'USD') },
    {
      header: t('hf.colHolding'), align: 'right',
      accessor: (f) => <Dash value={f.holdingMonths}>{t('hf.months', { count: String(f.holdingMonths) })}</Dash>,
    },
    {
      header: t('hf.colExpectedReturn'),
      // El texto CRUDO del CRM: es lo que el cliente firmó. El rango parseado
      // sólo se usa para proyectar, nunca para reescribir esta celda.
      accessor: (f) => <Dash value={f.expectedReturnRaw}>{f.expectedReturnRaw}</Dash>,
    },
    { header: t('hf.colApproval'), accessor: (f) => f.approvalMode ?? '—' },
    {
      header: t('hf.colProfitsLocked'),
      accessor: (f) => <Dash value={f.profitsLocked}>{f.profitsLocked ? '✓' : '—'}</Dash>,
    },
    { header: t('hf.colAum'), align: 'right', accessor: (f) => money(f.aum, f.currency ?? 'USD') },
    { header: t('hf.colClients'), align: 'right', accessor: (f) => f.clients },
    {
      header: t('hf.colAvgTicket'), align: 'right',
      // `null` cuando no hay ninguna inversión activa: un 0 diría «el ticket es
      // cero», que es otra afirmación.
      accessor: (f) => <Dash value={f.averageTicket}>{money(f.averageTicket, f.currency ?? 'USD')}</Dash>,
    },
    {
      header: t('hf.colLastPayout'), align: 'right',
      accessor: (f) => (
        <Dash value={f.lastPayoutAt}>
          {formatDate(f.lastPayoutAt ?? '')}
          {f.lastPayoutPercent !== null && (
            <span className="block text-xs text-muted-foreground">{f.lastPayoutPercent}%</span>
          )}
        </Dash>
      ),
    },
  ];
  return (
    <DataTable
      columns={cols} data={funds} density="compact" zebra
      empty={<EmptyState compact icon={Landmark} title={t('hf.noData')} />}
    />
  );
}

function Programas({ funds, t, onPick }: { funds: FundSummary[]; t: T; onPick: (k: string) => void }) {
  return (
    <Card>
      <TablaProgramas funds={funds} t={t} onPick={onPick} />
    </Card>
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

  const cols: Column<InvestmentRow>[] = [
    { header: t('hf.colRef'), accessor: (r) => r.ref ?? r.investmentId.slice(0, 8) },
    {
      header: t('hf.colClient'),
      accessor: (r) => (
        // Un perfil que no cruzó NO borra la fila ni la disfraza: se muestra el
        // id crudo para que el cruce roto se pueda ver y arreglar.
        <Dash value={r.client}>
          <span className="font-medium">{r.client?.name ?? r.client?.username ?? r.userExternalId}</span>
          <span className="block text-xs text-muted-foreground">{r.client?.email ?? ''}</span>
        </Dash>
      ),
    },
    { header: t('hf.colProgram'), accessor: (r) => r.program ?? r.fundKey ?? '—' },
    { header: t('hf.colPrincipal'), align: 'right', accessor: (r) => money(r.principal, r.currency ?? 'USD') },
    { header: t('hf.colBalance'), align: 'right', accessor: (r) => money(r.balance, r.currency ?? 'USD') },
    { header: t('hf.colStart'), accessor: (r) => <Dash value={r.startDate}>{formatDate(r.startDate ?? '')}</Dash> },
    { header: t('hf.colEnd'), accessor: (r) => <Dash value={r.endDate}>{formatDate(r.endDate ?? '')}</Dash> },
    {
      header: t('hf.colDaysLeft'), align: 'right',
      // Negativo = ya venció y sigue abierta. Se colorea; no se esconde.
      accessor: (r) => (
        <Dash value={r.daysLeft}>
          <span className={r.daysLeft !== null && r.daysLeft < 0 ? 'text-negative font-medium' : ''}>
            {r.daysLeft}
          </span>
        </Dash>
      ),
    },
    {
      header: t('hf.colStatus'),
      accessor: (r) => <Badge variant={r.status === 'ACTIVE' ? 'success' : 'neutral'}>{r.status ?? '—'}</Badge>,
    },
    {
      header: t('hf.colCertificate'),
      accessor: (r) => <Dash value={r.certificate}>{r.certificate?.number}</Dash>,
    },
  ];

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="block text-muted-foreground mb-1">{t('hf.filterFund')}</span>
          <select
            value={props.fundFilter} onChange={(e) => props.setFundFilter(e.target.value)}
            className="h-8 rounded-md border border-border bg-card px-2 text-xs"
          >
            <option value="">{t('hf.filterAll')}</option>
            {funds.map((f) => <option key={f.fundKey} value={f.fundKey}>{f.name ?? f.fundKey}</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="block text-muted-foreground mb-1">{t('hf.filterStatus')}</span>
          <select
            value={props.statusFilter} onChange={(e) => props.setStatusFilter(e.target.value)}
            className="h-8 rounded-md border border-border bg-card px-2 text-xs"
          >
            <option value="">{t('hf.filterAll')}</option>
            {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="text-xs">
          <span className="block text-muted-foreground mb-1">{t('hf.filterDueBefore')}</span>
          <input
            type="date" value={props.dueBefore} onChange={(e) => props.setDueBefore(e.target.value)}
            className="h-8 rounded-md border border-border bg-card px-2 text-xs"
          />
        </label>
        <div className="ml-auto flex items-center gap-2">
          <ExcludedBadge excluded={data?.excluded ?? null} t={t} />
          <Button variant="secondary" size="sm" onClick={exportar} disabled={rows.length === 0}>
            <Download className="w-3.5 h-3.5" />
            {t('hf.exportCsv')}
          </Button>
        </div>
      </div>

      {/* Un cruce que no encontró perfil se CUENTA y se dice. */}
      {(data?.withoutProfile ?? 0) > 0 && (
        <p className="text-xs text-warning">
          {data!.withoutProfile} / {rows.length} · sin perfil del CRM
        </p>
      )}

      {data === null ? (
        <Skeleton className="h-40" />
      ) : (
        <DataTable
          columns={cols} data={rows} density="compact" zebra stickyHeader
          empty={<EmptyState compact icon={Users} title={t('hf.noInvestments')} />}
        />
      )}
    </Card>
  );
}

// ── Pagos ────────────────────────────────────────────────────────────────────

function TotalesPorMes({ data }: { data: ByMonth }) {
  if (data.months.length === 0 && data.withoutDate === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      {data.months.map((m) => (
        <span key={m.ym} className="rounded-md border border-border px-2 py-1">
          <span className="text-muted-foreground">{m.ym}</span>{' '}
          <span className="tabular-nums font-medium">{money(m.amount)}</span>{' '}
          <span className="text-muted-foreground">({m.count})</span>
        </span>
      ))}
      {/* Un importe sin fecha NO se cuelga de un mes inventado: se dice aparte. */}
      {data.withoutDate > 0 && (
        <span className="rounded-md border border-warning/40 text-warning px-2 py-1">
          {data.withoutDate} sin fecha · {money(data.withoutDateAmount)}
        </span>
      )}
    </div>
  );
}

function Pagos({ data, t }: { data: PaymentsResponse | null; t: T }) {
  if (!data) return <Skeleton className="h-60" />;
  return (
    <div className="space-y-6">
      {/* (a) Rendimientos */}
      <Card>
        <header className="mb-3">
          <h2 className="font-semibold">{t('hf.payoutsBlock')}</h2>
          <p className="text-xs text-muted-foreground">{t('hf.payoutsBlockHint')}</p>
        </header>
        <DataTable
          density="compact" zebra
          data={data.returns.runs}
          empty={<EmptyState compact icon={Banknote} title={t('hf.noPayouts')} />}
          columns={[
            { header: t('hf.colDate'), accessor: (r) => <Dash value={r.at}>{formatDate(r.at ?? '')}</Dash> },
            { header: t('hf.colProgram'), accessor: (r) => r.program ?? r.fundKey ?? '—' },
            { header: t('hf.colPercent'), align: 'right', accessor: (r) => <Dash value={r.percent}>{r.percent}%</Dash> },
            { header: t('hf.colAccounts'), align: 'right', accessor: (r) => <Dash value={r.accountsAffected}>{r.accountsAffected}</Dash> },
            { header: t('hf.colAmount'), align: 'right', accessor: (r) => money(r.totalCredited, r.currency ?? 'USD') },
            { header: t('hf.colStatus'), accessor: (r) => r.status ?? '—' },
          ]}
        />
        <TotalesPorMes data={data.returns.byMonth} />
      </Card>

      {/* (b) Comisiones — con los reversos a la vista */}
      <Card>
        <header className="mb-3">
          <h2 className="font-semibold">{t('hf.commissionsBlock')}</h2>
          <p className="text-xs text-muted-foreground">{t('hf.commissionsBlockHint')}</p>
        </header>
        <div className="grid grid-cols-3 gap-3 mb-3 text-sm">
          <div><span className="block text-xs text-muted-foreground">{t('hf.colAmount')}</span>{money(data.commissions.totals.paid)}</div>
          <div>
            <span className="block text-xs text-muted-foreground">reversos ({data.commissions.totals.reversedCount})</span>
            <span className="text-negative">{money(data.commissions.totals.reversed)}</span>
          </div>
          <div>
            <span className="block text-xs text-muted-foreground">neto</span>
            {/* Sin clamp a 0: un neto negativo ES deuda de la red (§2.1 #1). */}
            <span className={data.commissions.totals.net < 0 ? 'text-negative font-medium' : 'font-medium'}>
              {money(data.commissions.totals.net)}
            </span>
          </div>
        </div>
        <DataTable
          density="compact" zebra
          data={data.commissions.rows}
          empty={<EmptyState compact icon={Banknote} title={t('hf.noCommissions')} />}
          columns={[
            { header: t('hf.colDate'), accessor: (r) => <Dash value={r.at}>{formatDate(r.at ?? '')}</Dash> },
            { header: t('hf.colType'), accessor: (r) => r.type ?? '—' },
            { header: t('hf.colBeneficiary'), accessor: (r) => r.beneficiary ?? '—' },
            { header: t('hf.colSource'), accessor: (r) => r.source ?? '—' },
            { header: t('hf.colLevel'), align: 'right', accessor: (r) => <Dash value={r.level}>{r.level}</Dash> },
            { header: t('hf.colPercent'), align: 'right', accessor: (r) => <Dash value={r.percent}>{r.percent}%</Dash> },
            {
              header: t('hf.colAmount'), align: 'right',
              accessor: (r) => (
                <span className={(r.amount ?? 0) < 0 ? 'text-negative' : ''}>{money(r.amount, r.currency ?? 'USD')}</span>
              ),
            },
            { header: t('hf.colMonth'), accessor: (r) => r.ym ?? '—' },
          ]}
        />
        <TotalesPorMes data={data.commissions.byMonth} />
      </Card>

      {/* (c) Capital devuelto y solicitudes */}
      <Card>
        <header className="mb-3">
          <h2 className="font-semibold">{t('hf.capitalBlock')}</h2>
          <p className="text-xs text-muted-foreground">{t('hf.capitalBlockHint')}</p>
        </header>
        <DataTable
          density="compact" zebra
          data={[
            ...data.capital.requests.map((r) => ({
              id: r.requestId, kind: 'request' as const, at: r.at,
              fundKey: r.fundKey, amount: r.amount, currency: r.currency, status: r.status,
            })),
            ...data.capital.terminations.map((r) => ({
              id: r.entryId, kind: 'termination' as const, at: r.at,
              fundKey: r.fundKey, amount: r.amount, currency: r.currency, status: 'TERMINATION',
            })),
          ]}
          empty={<EmptyState compact icon={Wallet} title={t('hf.noCapitalReturns')} />}
          columns={[
            { header: t('hf.colDate'), accessor: (r) => <Dash value={r.at}>{formatDate(r.at ?? '')}</Dash> },
            { header: t('hf.colType'), accessor: (r) => r.kind },
            { header: t('hf.colProgram'), accessor: (r) => r.fundKey ?? '—' },
            { header: t('hf.colAmount'), align: 'right', accessor: (r) => money(r.amount, r.currency ?? 'USD') },
            { header: t('hf.colStatus'), accessor: (r) => r.status ?? '—' },
          ]}
        />
        <TotalesPorMes data={data.capital.byMonth} />
      </Card>

      {/* Un tipo de asiento que no cae en ninguno de los tres bloques APARECE.
          Callarlo lo haría desaparecer del módulo sin dejar rastro. */}
      {data.otherLedgerTypes.length > 0 && (
        <p className="text-xs text-warning">
          Otros tipos de asiento en el libro: {data.otherLedgerTypes.join(', ')}
        </p>
      )}
    </div>
  );
}

// ── Vencimientos ─────────────────────────────────────────────────────────────

function Vencimientos({ data, t }: { data: MaturitiesResponse | null; t: T }) {
  if (!data) return <Skeleton className="h-60" />;
  return (
    <Card className="space-y-4">
      <header>
        <h2 className="font-semibold">{t('hf.maturitiesTitle')}</h2>
        <p className="text-xs text-warning flex items-center gap-1.5 mt-1">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {t('hf.projectionWarning')}
        </p>
      </header>

      {/* Capital activo SIN fecha de fin: no entra a ningún mes, así que hay
          que decirlo o desaparece del calendario en silencio. */}
      {data.activeWithoutEndDate > 0 && (
        <p className="text-xs text-warning">
          {data.activeWithoutEndDate} / {data.activeCount} · sin fecha de vencimiento
        </p>
      )}

      <DataTable
        density="compact" zebra
        data={data.months}
        empty={<EmptyState compact icon={CalendarClock} title={t('hf.noMaturities')} />}
        columns={[
          { header: t('hf.colMonth'), accessor: (m) => m.ym },
          { header: t('hf.colCount'), align: 'right', accessor: (m) => m.count },
          { header: t('hf.colPrincipal'), align: 'right', accessor: (m) => money(m.principal) },
          {
            header: t('hf.colProjected'), align: 'right',
            // `null` = ninguna inversión del mes se pudo proyectar. «—», nunca
            // 0: un 0 se leería como «ese mes no rinde nada».
            accessor: (m) => (
              <Dash value={m.projected}>
                <span className="tabular-nums">
                  {money(m.projected?.min)} – {money(m.projected?.max)}
                </span>
                {m.withoutProjection > 0 && (
                  <span className="block text-[11px] text-warning">
                    {t('hf.projectionMissing', { count: String(m.withoutProjection) })}
                  </span>
                )}
              </Dash>
            ),
          },
        ]}
      />

      {/* El rendimiento REAL del mes, cuando el CRM lo tenga. Hoy la colección
          está vacía en las dos empresas: se dice «sin datos», no 0%. */}
      <div>
        <h3 className="text-sm font-medium mb-2">
          {t('hf.colProjected')} vs. real
          <InfoTip className="ml-1.5" text={t('hf.projectionWarning')} />
        </h3>
        {data.actualMonthlyReturns.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('hf.noData')}</p>
        ) : (
          <DataTable
            density="compact"
            data={data.actualMonthlyReturns}
            columns={[
              { header: t('hf.colMonth'), accessor: (r) => r.ym },
              { header: t('hf.colProgram'), accessor: (r) => r.fundKey },
              { header: t('hf.colPercent'), align: 'right', accessor: (r) => <Dash value={r.percent}>{r.percent}%</Dash> },
              { header: t('hf.colAmount'), align: 'right', accessor: (r) => <Dash value={r.amount}>{money(r.amount)}</Dash> },
            ]}
          />
        )}
      </div>
    </Card>
  );
}
