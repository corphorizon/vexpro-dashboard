'use client';

import type { ReportData } from '@/lib/reports/data';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { FileSpreadsheet, FileText, RefreshCw, Send } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionButton } from '@/components/payment-orders/action-button';
import { SourceTag } from '@/app/(dashboard)/movimientos/source-tag';
import { useAuth, isCompanyAdmin } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { features } from '@/lib/business-model';
import { useModuleAccess } from '@/lib/use-module-access';
import { useData } from '@/lib/data-context';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { downloadCSV } from '@/lib/csv-export';
import { formatMoney } from '@/lib/money';
// Lazy-loaded (Kevin 2026-06-06 code review): jspdf + jspdf-autotable
// pesan ~700KB del bundle de /finanzas/reportes aunque solo se usen al
// hacer click en "Descargar PDF". Dynamic-import los carga al primer
// click — el resto de la página queda más liviana.
// import { downloadReportPDF } from '@/lib/reports/pdf';
import { ReportsConfigPanel } from './config-panel';
import { SendReportModal } from './send-modal';
import { CompanyReportSections, useCompanyReport } from './company-sections';
import { companyReportCsvRows } from '@/lib/reports/company-report';
import {
  channelAmount,
  channelSourceKind,
  missingChannelLabels,
  pctOfMonth,
  pctVariation,
  roundPct,
} from './report-view';

// ─────────────────────────────────────────────────────────────────────────────
// /finanzas/reportes — Operational financial report for a date range.
//
// Four sections:
//   1. Depósitos y Retiros        — manual + API totals for the range +
//                                    context from the current month + prev
//   2. Usuarios CRM                — new users, monthly, platform total
//   3. Broker P&L                  — range vs month vs prev month
//   4. Prop Trading Firm           — product sales, withdrawals, P&L
//
// All data flows through ONE endpoint (/api/reports/consolidated) which
// fans out to Supabase + Orion CRM in parallel. Keeps page load to a
// single round-trip regardless of how many sources we sum.
//
// ── «LIBRO MAYOR» (2026-10-12) ────────────────────────────────────────────
//   · Cada sección es un `Panel`; sus `StatCard` de colores → una `KpiStrip`
//     (la variación vs. mes anterior va como `delta` del KPI, con la misma
//     regla de null de siempre: report-view.ts); tablas a mano → `FinTable`.
//   · Lo que el endpoint YA decía y la pantalla callaba:
//       - `failures` (fuentes que no respondieron) → Notice `bad`;
//       - `truncated` (consultas que tocaron el techo de filas: cifras
//         posiblemente CORTAS) → Notice `pend`;
//       - canales con `source: 'missing'` se pintaban «$0.00» como una
//         wallet vacía → «—» + aviso «no están sumados» (el total del
//         endpoint ya los sumaba en 0; no cambia);
//       - días sin cierre del CRM en el P&L → sub del KPI.
//   · Color = significado: el P&L lleva signo de color (`sign`); depósito
//     neto sólo pinta negativos; el total de balances ya no va en verde.
//     Rangos rápidos → `Chip`; botones → `ActionButton` (el primario usa
//     `text-brand-on-primary`, antes `text-white` fijo).
//   Medido antes/después en este archivo: 14 clases de paleta cruda + 6
//   `dark:` + 1 `text-[10px]` → 0; 43 tokens legados → 0.
//   CSV y PDF: mismos campos, mismos valores (sólo cambió dónde se pinta).
//
// DESCARTADO: mover CHANNEL_LABEL / CATEGORY_LABEL a un registro — son de
// esta pantalla y no se tocaron (otra tanda, si aparece una segunda copia).
// ─────────────────────────────────────────────────────────────────────────────

type QuickRange = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'prevMonth';

const QUICK_RANGES: Array<{ key: QuickRange; labelKey: string }> = [
  { key: 'today', labelKey: 'reports.rangeToday' },
  { key: 'yesterday', labelKey: 'reports.rangeYesterday' },
  { key: 'last7', labelKey: 'reports.rangeLast7' },
  { key: 'thisMonth', labelKey: 'reports.rangeThisMonth' },
  { key: 'prevMonth', labelKey: 'reports.rangePrevMonth' },
];

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoFromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function computeQuickRange(kind: QuickRange): { from: string; to: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (kind === 'today') {
    const t = isoFromDate(today);
    return { from: t, to: t };
  }
  if (kind === 'yesterday') {
    const y = new Date(today);
    y.setDate(y.getDate() - 1);
    const ys = isoFromDate(y);
    return { from: ys, to: ys };
  }
  if (kind === 'last7') {
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    return { from: isoFromDate(start), to: isoFromDate(today) };
  }
  if (kind === 'thisMonth') {
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    return { from: isoFromDate(start), to: isoFromDate(today) };
  }
  // prevMonth
  const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const end = new Date(today.getFullYear(), today.getMonth(), 0);
  return { from: isoFromDate(start), to: isoFromDate(end) };
}

// ─── Server response types ─────────────────────────────────────────────

// ─── El tipo de la respuesta sale del BUILDER, no de una copia ───────────────
// Hasta el 2026-08-31 esta pantalla redeclaraba `ReportBucket` y todo el shape
// de `ReportData` a mano, y ya había divergido: `balances_by_channel.type`
// decía `'api' | 'manual' | 'auto'` con un `'api'` que no existe en ninguna
// fila, y los `number | null` de broker_pnl / prop_trading tuvieron que
// re-anotarse acá cuando cambiaron allá. Una copia del tipo de una respuesta es
// una copia que compila aunque el servidor ya devuelva otra cosa: el
// desacuerdo aparece en pantalla, no en tsc (auditoría de finanzas, ítem 15).
type ReportResponse = ReportData & { success: boolean };
type ChannelRow = ReportData['balances_by_channel']['channels'][number];
type ProductRow = NonNullable<ReportData['prop_trading']['products']>[number];

interface FlowRow {
  label: string;
  count: number;
  amount: number;
}

// ─── Human-friendly labels ─────────────────────────────────────────────

// Pay-Pros faltaba en las dos (auditoría 2026-08-31). El canal existe desde el
// 2026-07-22 y el informe ya traía sus depósitos: sin entrada acá, la fila se
// dibujaba con el slug crudo, «paypros», al lado de «Coinsbuy» y «FairPay».
const CHANNEL_LABEL: Record<string, string> = {
  coinsbuy: 'Coinsbuy',
  fairpay: 'FairPay',
  unipayment: 'UniPayment',
  paypros: 'Pay-Pros',
};
const CATEGORY_LABEL: Record<string, string> = {
  broker: 'Broker',
  prop_firm: 'Prop Firm',
  p2p: 'P2P Transfer',
  coinsbuy_api: 'Coinsbuy (API)',
  paypros_api: 'Pay-Pros (API)',
};
const CHANNEL_LABEL_KEY: Record<string, string> = {
  other: 'reports.labelOther',
};
const CATEGORY_LABEL_KEY: Record<string, string> = {
  ib_commissions: 'reports.categoryIbCommissions',
  other: 'reports.labelOther',
};

function resolveLabel(
  raw: string,
  literals: Record<string, string>,
  keys: Record<string, string>,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const k = keys[raw];
  if (k) return t(k);
  return literals[raw] ?? raw;
}

/** Para el CSV: la celda vacía dice «no lo sabemos»; un 0 diría otra cosa. */
function csvNumber(value: number | null): string | number {
  return value === null || !Number.isFinite(value) ? '' : value;
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function ReportesPage() {
  const { user } = useAuth();
  const { company } = useData();
  const { t } = useI18n();
  // Una consultora no tiene depósitos ni retiros: esa sección saldría en cero
  // todos los días. Y las que quedaban en pie —balances por canal, usuarios
  // del CRM, P&L, prop firm— tampoco son su negocio: para ella el reporte es
  // facturación, egresos, resultado y dónde está la plata.
  const { movements: showFlows } = features(company?.business_model);
  const isCompanyModel = !showFlows;
  const canAccess = useModuleAccess('reports');
  const { verify2FA, Modal2FA } = useExport2FA(user?.twofa_enabled);

  // Date range state — default Today.
  const defaultRange = useMemo(() => computeQuickRange('today'), []);
  const [from, setFrom] = useState(defaultRange.from);
  const [to, setTo] = useState(defaultRange.to);
  const [activeQuickRange, setActiveQuickRange] = useState<QuickRange | null>('today');

  const [data, setData] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const isAdmin = isCompanyAdmin(user);

  const applyQuickRange = (kind: QuickRange) => {
    const r = computeQuickRange(kind);
    setFrom(r.from);
    setTo(r.to);
    setActiveQuickRange(kind);
  };

  const load = useCallback(async () => {
    if (!from || !to) return;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ from, to });
      const res = await apiFetch(`/api/reports/consolidated?${qs}`);
      const json = (await res.json()) as ReportResponse;
      if (!json.success) throw new Error(t('reports.errorLoad'));
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reports.errorGeneric'));
    } finally {
      setLoading(false);
    }
  }, [from, to, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Los saldos salen del mismo endpoint que ya trajo la página: el reporte de
  // la empresa no puede mostrar una caja distinta a la de sus propios canales.
  const channelBalances = useMemo(
    () =>
      (data?.balances_by_channel.channels ?? []).map((c) => ({
        key: c.key,
        label: c.label,
        amount: c.amount,
      })),
    [data],
  );
  const {
    report: companyReport,
    billingFailed,
    classificationFailed,
  } = useCompanyReport(from, to, channelBalances, isCompanyModel);

  // Derive UI values.
  const rangeNet = data?.deposits_withdrawals.range.net_deposit ?? 0;
  const monthNet = data?.deposits_withdrawals.month.net_deposit ?? 0;
  const prevNet = data?.deposits_withdrawals.prev_month.net_deposit ?? 0;

  const netRangePctOfMonth = useMemo(() => pctOfMonth(rangeNet, monthNet), [rangeNet, monthNet]);
  const monthVsPrev = useMemo(() => pctVariation(monthNet, prevNet), [monthNet, prevNet]);

  const brokerPnlMonthVsPrev = useMemo(() => {
    if (!data) return null;
    return pctVariation(data.broker_pnl.pnl_month, data.broker_pnl.pnl_prev_month);
  }, [data]);
  const brokerPnlRangePctOfMonth = useMemo(() => {
    const p = data?.broker_pnl;
    return p ? pctOfMonth(p.pnl_range, p.pnl_month) : null;
  }, [data]);

  const propPnlMonthVsPrev = useMemo(() => {
    if (!data) return null;
    return pctVariation(data.prop_trading.pnl_month, data.prop_trading.pnl_prev_month);
  }, [data]);
  const propPnlRangePctOfMonth = useMemo(() => {
    const p = data?.prop_trading;
    return p ? pctOfMonth(p.pnl_range, p.pnl_month) : null;
  }, [data]);

  // ── Export handlers ────────────────────────────────────────────────
  const handleExportCSV = () => verify2FA(() => {
    const headers = ['Sección', 'Métrica', 'Valor'];
    if (isCompanyModel) {
      if (!companyReport) return;
      downloadCSV(`reporte_${from}_${to}.csv`, headers, companyReportCsvRows(companyReport));
      return;
    }
    if (!data) return;
    const rows: (string | number)[][] = [
      ['Período', 'Desde', from],
      ['Período', 'Hasta', to],
      ['Depósitos', 'Total depósitos del rango', data.deposits_withdrawals.range.total_deposits],
      ['Depósitos', 'Total retiros del rango', data.deposits_withdrawals.range.total_withdrawals],
      ['Depósitos', 'Depósito Neto del rango', data.deposits_withdrawals.range.net_deposit],
      ['Depósitos', 'Depósito Neto del mes', monthNet],
      ['Depósitos', 'Depósito Neto mes anterior', prevNet],
      ['CRM Users', 'Nuevos usuarios del rango', data.crm_users.new_users_in_range],
      ['CRM Users', 'Nuevos usuarios del mes', data.crm_users.new_users_this_month],
      ['CRM Users', 'Total usuarios', data.crm_users.total_users],
      // Celda VACÍA cuando no lo sabemos: un 0 en un CSV que después alguien
      // suma en una planilla es exactamente el fallo que no da error.
      ['Broker P&L', 'P&L del rango', csvNumber(data.broker_pnl.pnl_range)],
      ['Broker P&L', 'P&L del mes', csvNumber(data.broker_pnl.pnl_month)],
      ['Broker P&L', 'P&L mes anterior', csvNumber(data.broker_pnl.pnl_prev_month)],
      ['Prop Trading', 'Ventas del rango', csvNumber(data.prop_trading.total_sales_range)],
      ['Prop Trading', 'Retiros del rango', csvNumber(data.prop_trading.prop_withdrawals_range)],
      ['Prop Trading', 'P&L del rango', csvNumber(data.prop_trading.pnl_range)],
      ...(data.prop_trading.products === null
        ? [['Prop Trading · Productos', 'Sin desglose disponible', '']]
        : data.prop_trading.products.map((p) => [
            'Prop Trading · Productos',
            `${p.name} (x${p.quantity})`,
            p.amount,
          ])),
    ];
    downloadCSV(`reporte_${from}_${to}.csv`, headers, rows);
  });

  const exportsReady = isCompanyModel ? !!data && !!companyReport : !!data;

  const handleExportPDF = () =>
    verify2FA(() => {
      if (!exportsReady || !data) return;
      // Company theme — primary colour + logo data-URL (fetched from the
      // CSS custom property if possible). The PDF generator handles fallbacks.
      const cssPrimary =
        typeof window !== 'undefined'
          ? getComputedStyle(document.documentElement).getPropertyValue('--color-primary').trim()
          : '';
      void (async () => {
        const { downloadReportPDF } = await import('@/lib/reports/pdf');
        await downloadReportPDF({
          data: data as unknown as import('@/lib/reports/data').ReportData,
          cadence: 'daily',
          companyName: company?.name ?? 'Smart Dashboard',
          companyLogoDataUrl: null, // logos served via URL, not inlined
          primaryColor: cssPrimary || null,
          // Con esto el generador reemplaza las secciones de broker por las
          // de la empresa: misma portada, mismo pie, mismo archivo.
          companyReport: companyReport ?? undefined,
        });
      })();
    });

  // ── Render ─────────────────────────────────────────────────────────

  if (!canAccess) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-text-2">{t('reports.noAccess')}</p>
      </div>
    );
  }

  // Any mock data present anywhere in the response?
  const anyMock =
    (data?.crm_users.isMock ?? false) ||
    (data?.broker_pnl.isMock ?? false) ||
    (data?.prop_trading.isMock ?? false);

  const mockBadge = <StatusBadge kind="pend" label={t('reports.lm.mock')} />;
  const pctSub = (pct: number | null, key: 'reports.pctOfCurrentMonth' | 'reports.pctOfMonth') =>
    pct === null ? t('reports.noMonthlyReference') : t(key, { pct: roundPct(pct) });
  const prevRef = t('reports.lm.prevMonthRef');

  return (
    <div className="space-y-4">
      {Modal2FA}

      {isAdmin && <ReportsConfigPanel />}
      {isAdmin && (
        <SendReportModal
          open={sendOpen}
          onClose={() => setSendOpen(false)}
          currentRange={{ from, to }}
        />
      )}

      <PageHeader
        title={t('reports.title')}
        subtitle={t('reports.subtitle')}
        actions={
          <>
            <ActionButton onClick={handleExportCSV} disabled={!exportsReady} aria-label={t('common.csv')}>
              <FileSpreadsheet aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="max-sm:hidden">{t('common.csv')}</span>
            </ActionButton>
            <ActionButton onClick={handleExportPDF} disabled={!exportsReady} aria-label="PDF">
              <FileText aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="max-sm:hidden">PDF</span>
            </ActionButton>
            {isAdmin && (
              <ActionButton variant="primary" onClick={() => setSendOpen(true)}>
                <Send aria-hidden className="size-[15px]" strokeWidth={1.75} />
                {t('reports.send')}
              </ActionButton>
            )}
          </>
        }
      />

      {/* Date range selector */}
      <Panel bodyClassName="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] text-text-2">
            {t('reports.from')}
            <Input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setActiveQuickRange(null);
              }}
              className="h-8 w-auto"
            />
          </label>
          <label className="flex items-center gap-2 text-[13px] text-text-2">
            {t('reports.to')}
            <Input
              type="date"
              value={to}
              max={todayISO()}
              onChange={(e) => {
                setTo(e.target.value);
                setActiveQuickRange(null);
              }}
              className="h-8 w-auto"
            />
          </label>
          <ActionButton variant="ghost" onClick={() => void load()} loading={loading}>
            {!loading && <RefreshCw aria-hidden className="size-[15px]" strokeWidth={1.75} />}
            {t('reports.refresh')}
          </ActionButton>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('reports.lm.quickRangeAria')}>
          {QUICK_RANGES.map((r) => (
            <Chip key={r.key} active={activeQuickRange === r.key} onClick={() => applyQuickRange(r.key)}>
              {t(r.labelKey)}
            </Chip>
          ))}
        </div>
      </Panel>

      {anyMock && (
        <Notice kind="pend" title={t('reports.lm.mockTitle')}>
          {t('reports.mockPrefix')}<strong>mock</strong>{t('reports.mockMiddle')}
          <em>{t('reports.externalApisPath')}</em>{t('reports.mockSuffix')}
        </Notice>
      )}

      {error && <Notice kind="bad" title={error} />}

      {/* Lo que el endpoint ya informaba y la pantalla no mostraba. */}
      {data && data.failures.length > 0 && (
        <Notice kind="bad" title={t('reports.lm.failuresTitle', { list: data.failures.join(', ') })}>
          {t('reports.lm.failuresBody')}
        </Notice>
      )}
      {data && data.truncated.length > 0 && (
        <Notice kind="pend" title={t('reports.lm.truncatedTitle', { list: data.truncated.join(', ') })}>
          {t('reports.lm.truncatedBody')}
        </Notice>
      )}

      {loading && !data && <ReportSkeleton />}

      {/* Modelo 'company': el reporte del broker no aplica — se reemplaza
          entero por facturación, egresos, resultado y dónde está la plata. */}
      {isCompanyModel &&
        (data && companyReport ? (
          <CompanyReportSections
            report={companyReport}
            billingFailed={billingFailed}
            classificationFailed={classificationFailed}
          />
        ) : (
          <ReportSkeleton />
        ))}

      {data && !isCompanyModel && (
        <BrokerSections
          data={data}
          showFlows={showFlows}
          rangeNet={rangeNet}
          monthNet={monthNet}
          prevNet={prevNet}
          netRangePctOfMonth={netRangePctOfMonth}
          monthVsPrev={monthVsPrev}
          brokerPnlMonthVsPrev={brokerPnlMonthVsPrev}
          brokerPnlRangePctOfMonth={brokerPnlRangePctOfMonth}
          propPnlMonthVsPrev={propPnlMonthVsPrev}
          propPnlRangePctOfMonth={propPnlRangePctOfMonth}
          mockBadge={mockBadge}
          pctSub={pctSub}
          prevRef={prevRef}
        />
      )}

      {!loading && !data && !error && (
        <Panel bodyClassName="flex flex-col items-center gap-3 py-6 text-center">
          <p className="text-[13px] text-text-2">{t('reports.noDataForPeriod')}</p>
          <ActionButton onClick={() => void load()}>{t('reports.retry')}</ActionButton>
        </Panel>
      )}
    </div>
  );
}

// ─── Secciones del broker ──────────────────────────────────────────────

interface BrokerSectionsProps {
  data: ReportResponse;
  showFlows: boolean;
  rangeNet: number;
  monthNet: number;
  prevNet: number;
  netRangePctOfMonth: number | null;
  monthVsPrev: number | null;
  brokerPnlMonthVsPrev: number | null;
  brokerPnlRangePctOfMonth: number | null;
  propPnlMonthVsPrev: number | null;
  propPnlRangePctOfMonth: number | null;
  mockBadge: React.ReactNode;
  pctSub: (pct: number | null, key: 'reports.pctOfCurrentMonth' | 'reports.pctOfMonth') => string;
  prevRef: string;
}

function BrokerSections({
  data,
  showFlows,
  rangeNet,
  monthNet,
  prevNet,
  netRangePctOfMonth,
  monthVsPrev,
  brokerPnlMonthVsPrev,
  brokerPnlRangePctOfMonth,
  propPnlMonthVsPrev,
  propPnlRangePctOfMonth,
  mockBadge,
  pctSub,
  prevRef,
}: BrokerSectionsProps) {
  const { t } = useI18n();

  // ── 1. Depósitos y retiros ──
  const netKpis: KpiItem[] = [
    {
      key: 'range',
      label: t('reports.netDepositRange'),
      value: rangeNet,
      format: 'money',
      hero: true,
      sub: pctSub(netRangePctOfMonth, 'reports.pctOfCurrentMonth'),
    },
    {
      key: 'month',
      label: t('reports.netDepositMonth'),
      value: monthNet,
      format: 'money',
      delta: monthVsPrev === null ? undefined : { pct: monthVsPrev, ref: prevRef },
      sub: monthVsPrev === null ? t('reports.noComparison') : undefined,
    },
    { key: 'prev', label: t('reports.netDepositPrevMonth'), value: prevNet, format: 'money' },
  ];
  const depositRows: FlowRow[] = data.deposits_withdrawals.range.deposits.map((d) => ({
    label: resolveLabel(d.channel, CHANNEL_LABEL, CHANNEL_LABEL_KEY, t),
    count: d.count,
    amount: d.amount,
  }));
  const withdrawalRows: FlowRow[] = data.deposits_withdrawals.range.withdrawals.map((w) => ({
    label: resolveLabel(w.category, CATEGORY_LABEL, CATEGORY_LABEL_KEY, t),
    count: w.count,
    amount: w.amount,
  }));

  // ── 2. Balances por canal ──
  const channels = data.balances_by_channel.channels;
  const missingChannels = missingChannelLabels(channels);
  const channelColumns: FinColumn<ChannelRow>[] = [
    {
      key: 'channel',
      header: t('reports.channel'),
      cell: (c) => c.label,
      meta: (c) => (c.isCustom ? t('reports.custom') : null),
    },
    {
      key: 'type',
      header: t('reports.type'),
      cell: (c) => (
        <SourceTag
          kind={channelSourceKind(c.type)}
          label={
            c.type === 'auto' ? t('reports.typeAuto') : c.type === 'api' ? t('reports.typeApi') : t('reports.typeManual')
          }
        />
      ),
      hideSm: true,
    },
    // Un canal sin dato es «—», no «$0.00» (channelAmount).
    { key: 'balance', header: t('reports.balance'), kind: 'money', value: (c) => channelAmount(c) },
  ];

  // ── 3. Usuarios CRM ──
  const crmKpis: KpiItem[] = [
    { key: 'range', label: t('reports.newInRange'), value: data.crm_users.new_users_in_range, format: 'count' },
    { key: 'month', label: t('reports.newThisMonth'), value: data.crm_users.new_users_this_month, format: 'count' },
    {
      key: 'total',
      label: t('reports.totalOnPlatform'),
      value: data.crm_users.total_users,
      format: 'count',
      hero: true,
    },
  ];

  // ── 4. Broker P&L ──
  // Días sin cierre del CRM: el total es más chico y creíble si no se dice.
  const crmPnl = data.broker_pnl.crm;
  const daysMissing = crmPnl?.days_missing.length ?? 0;
  const pnlKpis: KpiItem[] = [
    {
      key: 'range',
      label: t('reports.pnlRange'),
      value: data.broker_pnl.pnl_range,
      format: 'money',
      tone: 'sign',
      hero: true,
      sub:
        daysMissing > 0
          ? t('reports.lm.daysMissing', { count: String(daysMissing) })
          : pctSub(brokerPnlRangePctOfMonth, 'reports.pctOfCurrentMonth'),
    },
    {
      key: 'month',
      label: t('reports.pnlMonth'),
      value: data.broker_pnl.pnl_month,
      format: 'money',
      tone: 'sign',
      delta: brokerPnlMonthVsPrev === null ? undefined : { pct: brokerPnlMonthVsPrev, ref: prevRef },
      sub: brokerPnlMonthVsPrev === null ? t('reports.noComparison') : undefined,
    },
    { key: 'prev', label: t('reports.pnlPrevMonth'), value: data.broker_pnl.pnl_prev_month, format: 'money' },
  ];

  // ── 5. Prop trading ──
  const pt = data.prop_trading;
  const propKpis: KpiItem[] = [
    {
      key: 'pnlRange',
      label: t('reports.pnlRange'),
      value: pt.pnl_range,
      format: 'money',
      tone: 'sign',
      hero: true,
      sub: pctSub(propPnlRangePctOfMonth, 'reports.pctOfMonth'),
    },
    {
      key: 'sales',
      label: t('reports.salesRange'),
      value: pt.total_sales_range,
      format: 'money',
      sub: t('reports.monthHint', {
        amount: pt.total_sales_month === null ? t('reports.noData') : formatMoney(pt.total_sales_month),
      }),
    },
    {
      key: 'withdrawals',
      label: t('reports.propFirmWithdrawals'),
      value: pt.prop_withdrawals_range,
      format: 'money',
      sub:
        pt.prop_withdrawals_count_range === null
          ? t('reports.noData')
          : t('reports.withdrawalsCount', { count: String(pt.prop_withdrawals_count_range) }),
    },
    {
      key: 'pnlMonth',
      label: t('reports.propPnlMonth'),
      value: pt.pnl_month,
      format: 'money',
      tone: 'sign',
      delta: propPnlMonthVsPrev === null ? undefined : { pct: propPnlMonthVsPrev, ref: prevRef },
      sub: propPnlMonthVsPrev === null ? t('reports.noComparison') : undefined,
    },
    { key: 'pnlPrev', label: t('reports.propPnlPrevMonth'), value: pt.pnl_prev_month, format: 'money' },
  ];
  const productColumns: FinColumn<ProductRow>[] = [
    { key: 'name', header: t('reports.product'), cell: (p) => p.name },
    { key: 'quantity', header: t('reports.quantity'), kind: 'number', value: (p) => p.quantity },
    { key: 'amount', header: t('common.amount'), kind: 'money', value: (p) => p.amount },
  ];

  return (
    <>
      {/* SECTION 1 — Deposits & Withdrawals */}
      {showFlows && (
        <Panel flush title={t('reports.depositsWithdrawals')}>
          <div className="p-4">
            <KpiStrip items={netKpis} />
          </div>
          <div className="grid grid-cols-1 border-t border-border min-[1100px]:grid-cols-2">
            <FlowTable
              title={t('reports.depositsByChannel')}
              rows={depositRows}
              totalAmount={data.deposits_withdrawals.range.total_deposits}
              emptyLabel={t('reports.noDepositsInPeriod')}
            />
            <FlowTable
              title={t('reports.withdrawalsByCategory')}
              rows={withdrawalRows}
              totalAmount={data.deposits_withdrawals.range.total_withdrawals}
              emptyLabel={t('reports.noWithdrawalsInPeriod')}
              className="max-[1100px]:border-t min-[1100px]:border-l border-border"
            />
          </div>
        </Panel>
      )}

      {/* SECTION 2 — Balances por Canal */}
      {missingChannels.length > 0 && (
        <Notice
          kind="pend"
          title={t('reports.lm.missingChannelsTitle', {
            count: String(missingChannels.length),
            names: missingChannels.join(', '),
          })}
        >
          {t('reports.lm.missingChannelsBody')}
        </Notice>
      )}
      <Panel
        flush
        title={t('balances.byChannel')}
        hint={t('reports.asOf', { date: data.balances_by_channel.asOf })}
      >
        {channels.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-text-3">
            {t('reports.noChannels')}
            <strong>{t('reports.financeBalancesPath')}</strong>.
          </p>
        ) : (
          <FinTable
            columns={channelColumns}
            rows={channels}
            rowKey={(c) => c.key}
            caption={t('balances.byChannel')}
            footer={{
              label:
                missingChannels.length > 0
                  ? t('reports.lm.totalWithMissing', {
                      shown: String(channels.length - missingChannels.length),
                      total: String(channels.length),
                    })
                  : t('reports.totalConsolidated'),
              values: { balance: data.balances_by_channel.total },
            }}
          />
        )}
      </Panel>

      {/* SECTION 3 — CRM Users */}
      <Panel title={t('reports.crmUsers')} actions={data.crm_users.isMock ? mockBadge : undefined}>
        {!data.crm_users.connected && !data.crm_users.isMock ? <NotConnectedNotice /> : <KpiStrip items={crmKpis} />}
      </Panel>

      {/* SECTION 4 — Broker P&L */}
      <Panel title={t('summary.brokerPnl')} actions={data.broker_pnl.isMock ? mockBadge : undefined}>
        {!data.broker_pnl.connected && !data.broker_pnl.isMock ? <NotConnectedNotice /> : <KpiStrip items={pnlKpis} />}
      </Panel>

      {/* SECTION 5 — Prop Trading Firm */}
      <Panel flush title={t('reports.propTradingFirm')} actions={pt.isMock ? mockBadge : undefined}>
        {!pt.connected && !pt.isMock ? (
          <div className="p-4">
            <NotConnectedNotice />
          </div>
        ) : (
          <>
            <div className="p-4">
              <KpiStrip items={propKpis} />
            </div>
            <div className="border-t border-border px-4 py-2.5 text-[12px] font-semibold uppercase tracking-[.03em] text-text-3">
              {t('reports.productsSoldInRange')}
            </div>
            {pt.products === null ? (
              /* `null` no es una lista vacía: el CRM guarda el total del mes,
                 no qué se vendió. Decir «no hubo ventas» acá sería afirmar
                 algo que no sabemos (auditoría 2026-08-31). */
              <p className="px-4 pb-4 text-[13px] text-text-3">{t('reports.productsNoBreakdown')}</p>
            ) : pt.products.length === 0 ? (
              <p className="px-4 pb-4 text-[13px] text-text-3">{t('reports.noSalesInPeriod')}</p>
            ) : (
              <FinTable
                columns={productColumns}
                rows={pt.products}
                rowKey={(p) => p.name}
                caption={t('reports.productsSoldInRange')}
                footer={{ label: t('common.total'), values: { amount: pt.total_sales_range } }}
              />
            )}
          </>
        )}
      </Panel>
    </>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────

function FlowTable({
  title,
  rows,
  totalAmount,
  emptyLabel,
  className,
}: {
  title: string;
  rows: FlowRow[];
  totalAmount: number;
  emptyLabel: string;
  className?: string;
}) {
  const { t } = useI18n();
  const columns: FinColumn<FlowRow>[] = [
    { key: 'label', header: t('reports.channelCat'), cell: (r) => r.label },
    { key: 'count', header: '#', kind: 'number', value: (r) => r.count, hideSm: true },
    { key: 'amount', header: t('common.amount'), kind: 'money', value: (r) => r.amount },
  ];
  return (
    <div className={className}>
      <h3 className="px-4 pb-1 pt-3 text-[13px] font-semibold text-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-text-3">{emptyLabel}</p>
      ) : (
        <FinTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.label}
          caption={title}
          footer={{ label: t('common.total'), values: { amount: totalAmount } }}
        />
      )}
    </div>
  );
}

function NotConnectedNotice() {
  const { t } = useI18n();
  return (
    <Notice kind="pend" title={t('reports.crmNotConnected')}>
      {t('reports.crmNotConnectedHint')}<em>{t('reports.externalApisPath')}</em>{t('reports.mockSuffix')}
    </Notice>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-40 rounded-ui-lg" />
      ))}
    </div>
  );
}
