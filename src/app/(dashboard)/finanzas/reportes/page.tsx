'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import {
  BarChart3,
  Download,
  FileSpreadsheet,
  FileText,
  RefreshCw,
  Send,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { features } from '@/lib/business-model';
import { useModuleAccess } from '@/lib/use-module-access';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { downloadCSV } from '@/lib/csv-export';
// Lazy-loaded (Kevin 2026-06-06 code review): jspdf + jspdf-autotable
// pesan ~700KB del bundle de /finanzas/reportes aunque solo se usen al
// hacer click en "Descargar PDF". Dynamic-import los carga al primer
// click — el resto de la página queda más liviana.
// import { downloadReportPDF } from '@/lib/reports/pdf';
import { ReportsConfigPanel } from './config-panel';
import { SendReportModal } from './send-modal';
import { CompanyReportSections, useCompanyReport } from './company-sections';
import { companyReportCsvRows } from '@/lib/reports/company-report';

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
// ─────────────────────────────────────────────────────────────────────────────

type QuickRange = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'prevMonth';

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

interface ReportBucket {
  deposits: Array<{ channel: string; count: number; amount: number }>;
  withdrawals: Array<{ category: string; count: number; amount: number }>;
  total_deposits: number;
  total_withdrawals: number;
  net_deposit: number;
}

interface ReportResponse {
  success: boolean;
  range: { from: string; to: string };
  this_month: { from: string; to: string };
  prev_month: { from: string; to: string };
  deposits_withdrawals: {
    range: ReportBucket;
    month: ReportBucket;
    prev_month: { total_deposits: number; total_withdrawals: number; net_deposit: number };
  };
  crm_users: {
    new_users_in_range: number;
    new_users_this_month: number;
    total_users: number;
    connected: boolean;
    isMock: boolean;
  };
  broker_pnl: {
    pnl_range: number;
    pnl_month: number;
    pnl_prev_month: number;
    connected: boolean;
    isMock: boolean;
  };
  prop_trading: {
    products: Array<{ name: string; quantity: number; amount: number }>;
    total_sales_range: number;
    total_sales_month: number;
    prop_withdrawals_range: number;
    prop_withdrawals_count_range: number;
    pnl_range: number;
    pnl_month: number;
    pnl_prev_month: number;
    connected: boolean;
    isMock: boolean;
  };
  balances_by_channel: {
    channels: Array<{
      key: string;
      label: string;
      type: 'api' | 'manual' | 'auto';
      amount: number;
      source: 'live' | 'snapshot' | 'computed';
      isCustom: boolean;
    }>;
    total: number;
    asOf: string;
  };
}

// ─── Human-friendly labels ─────────────────────────────────────────────

const CHANNEL_LABEL: Record<string, string> = {
  coinsbuy: 'Coinsbuy',
  fairpay: 'FairPay',
  unipayment: 'UniPayment',
};
const CATEGORY_LABEL: Record<string, string> = {
  broker: 'Broker',
  prop_firm: 'Prop Firm',
  p2p: 'P2P Transfer',
  coinsbuy_api: 'Coinsbuy (API)',
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

// ─── Utility: % variation with safe zero division ──────────────────────

function pctVariation(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function VariationBadge({ pct }: { pct: number | null }) {
  const { t } = useI18n();
  if (pct === null || !isFinite(pct)) {
    return <span className="text-xs text-muted-foreground">{t('reports.noComparison')}</span>;
  }
  const rounded = Math.round(pct * 10) / 10;
  const positive = rounded >= 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  const cls = positive ? 'text-emerald-600' : 'text-red-600';
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${cls}`}>
      <Icon className="w-3 h-3" />
      {t('reports.variationVsPrevMonth', { pct: `${rounded > 0 ? '+' : ''}${rounded}` })}
    </span>
  );
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
  const isAdmin = user?.effective_role === 'admin';

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
  const companyReport = useCompanyReport(from, to, channelBalances, isCompanyModel);

  // Derive UI values.
  const rangeNet = data?.deposits_withdrawals.range.net_deposit ?? 0;
  const monthNet = data?.deposits_withdrawals.month.net_deposit ?? 0;
  const prevNet = data?.deposits_withdrawals.prev_month.net_deposit ?? 0;

  const netRangePctOfMonth = useMemo(() => {
    if (!monthNet) return null;
    return (rangeNet / Math.abs(monthNet)) * 100;
  }, [rangeNet, monthNet]);

  const monthVsPrev = useMemo(() => pctVariation(monthNet, prevNet), [monthNet, prevNet]);

  const brokerPnlMonthVsPrev = useMemo(() => {
    if (!data) return null;
    return pctVariation(data.broker_pnl.pnl_month, data.broker_pnl.pnl_prev_month);
  }, [data]);
  const brokerPnlRangePctOfMonth = useMemo(() => {
    if (!data || !data.broker_pnl.pnl_month) return null;
    return (data.broker_pnl.pnl_range / Math.abs(data.broker_pnl.pnl_month)) * 100;
  }, [data]);

  const propPnlMonthVsPrev = useMemo(() => {
    if (!data) return null;
    return pctVariation(data.prop_trading.pnl_month, data.prop_trading.pnl_prev_month);
  }, [data]);
  const propPnlRangePctOfMonth = useMemo(() => {
    if (!data || !data.prop_trading.pnl_month) return null;
    return (data.prop_trading.pnl_range / Math.abs(data.prop_trading.pnl_month)) * 100;
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
      ['Broker P&L', 'P&L del rango', data.broker_pnl.pnl_range],
      ['Broker P&L', 'P&L del mes', data.broker_pnl.pnl_month],
      ['Broker P&L', 'P&L mes anterior', data.broker_pnl.pnl_prev_month],
      ['Prop Trading', 'Ventas del rango', data.prop_trading.total_sales_range],
      ['Prop Trading', 'Retiros del rango', data.prop_trading.prop_withdrawals_range],
      ['Prop Trading', 'P&L del rango', data.prop_trading.pnl_range],
      ...data.prop_trading.products.map((p) => [
        'Prop Trading · Productos',
        `${p.name} (x${p.quantity})`,
        p.amount,
      ]),
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
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">{t('reports.noAccess')}</p>
      </div>
    );
  }

  // Any mock data present anywhere in the response?
  const anyMock =
    (data?.crm_users.isMock ?? false) ||
    (data?.broker_pnl.isMock ?? false) ||
    (data?.prop_trading.isMock ?? false);

  return (
    <div className="space-y-6">
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
        icon={BarChart3}
        actions={
          <div className="flex gap-2">
            {isAdmin && (
              <button
                onClick={() => setSendOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm hover:opacity-90"
              >
                <Send className="w-4 h-4" /> {t('reports.send')}
              </button>
            )}
            <button
              onClick={handleExportCSV}
              disabled={!exportsReady}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
            >
              <FileSpreadsheet className="w-4 h-4" /> {t('common.csv')}
            </button>
            <button
              onClick={handleExportPDF}
              disabled={!exportsReady}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
            >
              <FileText className="w-4 h-4" /> PDF
            </button>
          </div>
        }
      />

      {/* Date range selector */}
      <Card>
        <div className="flex flex-col lg:flex-row lg:items-center gap-4 justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t('reports.from')}</span>
              <input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setActiveQuickRange(null);
                }}
                className="px-2 py-1 rounded-md border border-border bg-background text-base sm:text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t('reports.to')}</span>
              <input
                type="date"
                value={to}
                max={todayISO()}
                onChange={(e) => {
                  setTo(e.target.value);
                  setActiveQuickRange(null);
                }}
                className="px-2 py-1 rounded-md border border-border bg-background text-base sm:text-sm"
              />
            </label>
            <button
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-sm hover:bg-muted"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              {t('reports.refresh')}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['today', 'yesterday', 'last7', 'thisMonth', 'prevMonth'] as QuickRange[]).map((r) => (
              <button
                key={r}
                onClick={() => applyQuickRange(r)}
                className={`px-3 py-1.5 rounded-md text-xs transition-colors ${
                  activeQuickRange === r
                    ? 'bg-[var(--color-primary)] text-white'
                    : 'border border-border hover:bg-muted'
                }`}
              >
                {r === 'today' && t('reports.rangeToday')}
                {r === 'yesterday' && t('reports.rangeYesterday')}
                {r === 'last7' && t('reports.rangeLast7')}
                {r === 'thisMonth' && t('reports.rangeThisMonth')}
                {r === 'prevMonth' && t('reports.rangePrevMonth')}
              </button>
            ))}
          </div>
        </div>
        {anyMock && (
          <p className="mt-3 text-xs text-warning">
            {t('reports.mockPrefix')}<strong>mock</strong>{t('reports.mockMiddle')}
            <em>{t('reports.externalApisPath')}</em>{t('reports.mockSuffix')}
          </p>
        )}
      </Card>

      {error && (
        <Card className="bg-negative/10 border-red-300 dark:border-red-800">
          <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
        </Card>
      )}

      {loading && !data && <Skeleton />}

      {/* Modelo 'company': el reporte del broker no aplica — se reemplaza
          entero por facturación, egresos, resultado y dónde está la plata. */}
      {isCompanyModel &&
        (data && companyReport ? <CompanyReportSections report={companyReport} /> : <Skeleton />)}

      {data && !isCompanyModel && (
        <>
          {/* SECTION 1 — Deposits & Withdrawals */}
          {showFlows && (
          <Card>
            <div className="flex items-center gap-2 mb-4">
              <Wallet className="w-5 h-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold">{t('reports.depositsWithdrawals')}</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              {/* Deposits by channel */}
              <div>
                <h3 className="text-sm font-medium mb-2">{t('reports.depositsByChannel')}</h3>
                <TableList
                  rows={data.deposits_withdrawals.range.deposits.map((d) => ({
                    label: resolveLabel(d.channel, CHANNEL_LABEL, CHANNEL_LABEL_KEY, t),
                    count: d.count,
                    amount: d.amount,
                  }))}
                  totalAmount={data.deposits_withdrawals.range.total_deposits}
                  emptyLabel={t('reports.noDepositsInPeriod')}
                />
              </div>

              {/* Withdrawals by category */}
              <div>
                <h3 className="text-sm font-medium mb-2">{t('reports.withdrawalsByCategory')}</h3>
                <TableList
                  rows={data.deposits_withdrawals.range.withdrawals.map((w) => ({
                    label: resolveLabel(w.category, CATEGORY_LABEL, CATEGORY_LABEL_KEY, t),
                    count: w.count,
                    amount: w.amount,
                  }))}
                  totalAmount={data.deposits_withdrawals.range.total_withdrawals}
                  emptyLabel={t('reports.noWithdrawalsInPeriod')}
                />
              </div>
            </div>

            {/* Range net + monthly context */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatCard
                label={t('reports.netDepositRange')}
                value={formatCurrency(rangeNet)}
                tone={rangeNet >= 0 ? 'positive' : 'negative'}
                hint={
                  netRangePctOfMonth === null
                    ? t('reports.noMonthlyReference')
                    : t('reports.pctOfCurrentMonth', {
                        pct: String(Math.round(netRangePctOfMonth * 10) / 10),
                      })
                }
              />
              <StatCard
                label={t('reports.netDepositMonth')}
                value={formatCurrency(monthNet)}
                tone={monthNet >= 0 ? 'positive' : 'negative'}
                hint={<VariationBadge pct={monthVsPrev} />}
              />
              <StatCard
                label={t('reports.netDepositPrevMonth')}
                value={formatCurrency(prevNet)}
                tone="neutral"
              />
            </div>
          </Card>

          )}

          {/* SECTION 2 — Balances por Canal */}
          <Card>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Wallet className="w-5 h-5 text-muted-foreground" />
                <h2 className="text-lg font-semibold">{t('balances.byChannel')}</h2>
              </div>
              <span className="text-xs text-muted-foreground">
                {t('reports.asOf', { date: data.balances_by_channel.asOf })}
              </span>
            </div>
            {data.balances_by_channel.channels.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                {t('reports.noChannels')}<strong>{t('reports.financeBalancesPath')}</strong>.
              </p>
            ) : (
              <div className="rounded-lg border border-border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                    <tr className="border-b border-border">
                      <th className="text-left py-2.5 px-3 font-medium">{t('reports.channel')}</th>
                      <th className="text-left py-2.5 px-3 font-medium">{t('reports.type')}</th>
                      <th className="text-right py-2.5 px-3 font-medium">{t('reports.balance')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.balances_by_channel.channels.map((c) => (
                      <tr key={c.key} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                        <td className="px-3 py-2">
                          {c.label}
                          {c.isCustom && (
                            <span className="ml-2 inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-800">
                              {t('reports.custom')}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground capitalize">
                          {c.type === 'auto'
                            ? t('reports.typeAuto')
                            : c.type === 'api'
                              ? t('reports.typeApi')
                              : t('reports.typeManual')}
                        </td>
                        <td
                          className={`px-3 py-2 text-right font-medium ${
                            c.amount >= 0 ? '' : 'text-negative'
                          }`}
                        >
                          {formatCurrency(c.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-muted/30 font-bold">
                    <tr className="border-t border-border">
                      <td className="px-3 py-2" colSpan={2}>
                        {t('reports.totalConsolidated')}
                      </td>
                      <td
                        className={`px-3 py-2 text-right ${
                          data.balances_by_channel.total >= 0
                            ? 'text-positive'
                            : 'text-negative'
                        }`}
                      >
                        {formatCurrency(data.balances_by_channel.total)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>

          {/* SECTION 3 — CRM Users */}
          <Card>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-muted-foreground" />
                <h2 className="text-lg font-semibold">{t('reports.crmUsers')}</h2>
              </div>
              {data.crm_users.isMock && <Badge variant="warning">{t('reports.mockBadge')}</Badge>}
            </div>
            {!data.crm_users.connected && !data.crm_users.isMock ? (
              <NotConnectedNotice />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard
                  label={t('reports.newInRange')}
                  value={data.crm_users.new_users_in_range.toLocaleString('es')}
                  tone="info"
                />
                <StatCard
                  label={t('reports.newThisMonth')}
                  value={data.crm_users.new_users_this_month.toLocaleString('es')}
                  tone="info"
                />
                <StatCard
                  label={t('reports.totalOnPlatform')}
                  value={data.crm_users.total_users.toLocaleString('es')}
                  tone="primary"
                />
              </div>
            )}
          </Card>

          {/* SECTION 3 — Broker P&L */}
          <Card>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-muted-foreground" />
                <h2 className="text-lg font-semibold">{t('summary.brokerPnl')}</h2>
              </div>
              {data.broker_pnl.isMock && <Badge variant="warning">{t('reports.mockBadge')}</Badge>}
            </div>
            {!data.broker_pnl.connected && !data.broker_pnl.isMock ? (
              <NotConnectedNotice />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard
                  label={t('reports.pnlRange')}
                  value={formatCurrency(data.broker_pnl.pnl_range)}
                  tone={data.broker_pnl.pnl_range >= 0 ? 'positive' : 'negative'}
                  hint={
                    brokerPnlRangePctOfMonth === null
                      ? t('reports.noMonthlyReference')
                      : t('reports.pctOfCurrentMonth', {
                          pct: String(Math.round(brokerPnlRangePctOfMonth * 10) / 10),
                        })
                  }
                />
                <StatCard
                  label={t('reports.pnlMonth')}
                  value={formatCurrency(data.broker_pnl.pnl_month)}
                  tone={data.broker_pnl.pnl_month >= 0 ? 'positive' : 'negative'}
                  hint={<VariationBadge pct={brokerPnlMonthVsPrev} />}
                />
                <StatCard
                  label={t('reports.pnlPrevMonth')}
                  value={formatCurrency(data.broker_pnl.pnl_prev_month)}
                  tone="neutral"
                />
              </div>
            )}
          </Card>

          {/* SECTION 4 — Prop Trading Firm */}
          <Card>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-muted-foreground" />
                <h2 className="text-lg font-semibold">{t('reports.propTradingFirm')}</h2>
              </div>
              {data.prop_trading.isMock && <Badge variant="warning">{t('reports.mockBadge')}</Badge>}
            </div>

            {!data.prop_trading.connected && !data.prop_trading.isMock ? (
              <NotConnectedNotice />
            ) : (
              <>
            {/* Products table */}
            <div className="mb-4">
              <h3 className="text-sm font-medium mb-2">{t('reports.productsSoldInRange')}</h3>
              {data.prop_trading.products.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3">
                  {t('reports.noSalesInPeriod')}
                </p>
              ) : (
                <div className="rounded-lg border border-border overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                      <tr className="border-b border-border">
                        <th className="text-left py-2.5 px-3 font-medium">{t('reports.product')}</th>
                        <th className="text-right py-2.5 px-3 font-medium">{t('reports.quantity')}</th>
                        <th className="text-right py-2.5 px-3 font-medium">{t('common.amount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.prop_trading.products.map((p) => (
                        <tr key={p.name} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
                          <td className="px-3 py-2">{p.name}</td>
                          <td className="px-3 py-2 text-right">{p.quantity}</td>
                          <td className="px-3 py-2 text-right">{formatCurrency(p.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-muted/30 font-medium">
                      <tr className="border-t border-border">
                        <td className="px-3 py-2">{t('common.total')}</td>
                        <td></td>
                        <td className="px-3 py-2 text-right">
                          {formatCurrency(data.prop_trading.total_sales_range)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>

            {/* Stats grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatCard
                label={t('reports.salesRange')}
                value={formatCurrency(data.prop_trading.total_sales_range)}
                tone="info"
                hint={t('reports.monthHint', {
                  amount: formatCurrency(data.prop_trading.total_sales_month),
                })}
              />
              <StatCard
                label={t('reports.propFirmWithdrawals')}
                value={formatCurrency(data.prop_trading.prop_withdrawals_range)}
                tone="warning"
                hint={t('reports.withdrawalsCount', {
                  count: String(data.prop_trading.prop_withdrawals_count_range),
                })}
              />
              <StatCard
                label={t('reports.pnlRange')}
                value={formatCurrency(data.prop_trading.pnl_range)}
                tone={data.prop_trading.pnl_range >= 0 ? 'positive' : 'negative'}
                hint={
                  propPnlRangePctOfMonth === null
                    ? t('reports.noMonthlyReference')
                    : t('reports.pctOfMonth', {
                        pct: String(Math.round(propPnlRangePctOfMonth * 10) / 10),
                      })
                }
              />
            </div>

            {/* Monthly comparison */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
              <StatCard
                label={t('reports.propPnlMonth')}
                value={formatCurrency(data.prop_trading.pnl_month)}
                tone={data.prop_trading.pnl_month >= 0 ? 'positive' : 'negative'}
                hint={<VariationBadge pct={propPnlMonthVsPrev} />}
              />
              <StatCard
                label={t('reports.propPnlPrevMonth')}
                value={formatCurrency(data.prop_trading.pnl_prev_month)}
                tone="neutral"
              />
            </div>
              </>
            )}
          </Card>
        </>
      )}

      {!loading && !data && !error && (
        <Card className="text-sm text-muted-foreground text-center py-6">
          {t('reports.noDataForPeriod')}{' '}
          <button
            onClick={() => void load()}
            className="underline text-primary dark:text-accent"
          >
            {t('reports.retry')}
          </button>
        </Card>
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────

function TableList({
  rows,
  totalAmount,
  emptyLabel,
}: {
  rows: Array<{ label: string; count: number; amount: number }>;
  totalAmount: number;
  emptyLabel: string;
}) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-3">{emptyLabel}</p>;
  }
  return (
    <div className="rounded-lg border border-border overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr className="border-b border-border">
            <th className="text-left py-2.5 px-3 font-medium">{t('reports.channelCat')}</th>
            <th className="text-right py-2.5 px-3 font-medium">#</th>
            <th className="text-right py-2.5 px-3 font-medium">{t('common.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
              <td className="px-3 py-2">{r.label}</td>
              <td className="px-3 py-2 text-right">{r.count}</td>
              <td className="px-3 py-2 text-right font-medium">{formatCurrency(r.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-muted/30 font-semibold">
          <tr className="border-t border-border">
            <td className="px-3 py-2">{t('common.total')}</td>
            <td></td>
            <td className="px-3 py-2 text-right">{formatCurrency(totalAmount)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function NotConnectedNotice() {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center">
      <p className="text-sm font-medium text-foreground">{t('reports.crmNotConnected')}</p>
      <p className="text-xs text-muted-foreground mt-1">
        {t('reports.crmNotConnectedHint')}<em>{t('reports.externalApisPath')}</em>{t('reports.mockSuffix')}
      </p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-40 rounded-xl bg-muted/60" />
      ))}
    </div>
  );
}

// Suppress icon import warning if Download isn't used elsewhere.
void Download;
