'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Download,
  FileSpreadsheet,
  FileText,
  RefreshCw,
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
import { useModuleAccess } from '@/lib/use-module-access';
import { useData } from '@/lib/data-context';
import { formatCurrency } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import { useExport2FA } from '@/components/verify-2fa-modal';
import { downloadCSV } from '@/lib/csv-export';
import { downloadPDF } from '@/lib/export-utils';

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
}

// ─── Human-friendly labels ─────────────────────────────────────────────

const CHANNEL_LABEL: Record<string, string> = {
  coinsbuy: 'Coinsbuy',
  fairpay: 'FairPay',
  unipayment: 'UniPayment',
  other: 'Otros',
};
const CATEGORY_LABEL: Record<string, string> = {
  ib_commissions: 'Comisiones IB',
  broker: 'Broker',
  prop_firm: 'Prop Firm',
  other: 'Otros',
  p2p: 'P2P Transfer',
  coinsbuy_api: 'Coinsbuy (API)',
};

// ─── Utility: % variation with safe zero division ──────────────────────

function pctVariation(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function VariationBadge({ pct }: { pct: number | null }) {
  if (pct === null || !isFinite(pct)) {
    return <span className="text-xs text-muted-foreground">sin comparativa</span>;
  }
  const rounded = Math.round(pct * 10) / 10;
  const positive = rounded >= 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  const cls = positive ? 'text-emerald-600' : 'text-red-600';
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${cls}`}>
      <Icon className="w-3 h-3" />
      {rounded > 0 ? '+' : ''}
      {rounded}% vs mes anterior
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────────────────

export default function ReportesPage() {
  const { user } = useAuth();
  const { company } = useData();
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
      const res = await fetch(`/api/reports/consolidated?${qs}`);
      const json = (await res.json()) as ReportResponse;
      if (!json.success) throw new Error('No se pudo cargar el reporte');
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando reporte');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

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
    if (!data) return;
    const headers = ['Sección', 'Métrica', 'Valor'];
    const rows: (string | number)[][] = [
      ['Período', 'Desde', from],
      ['Período', 'Hasta', to],
      ['Depósitos', 'Total depósitos del rango', data.deposits_withdrawals.range.total_deposits],
      ['Depósitos', 'Total retiros del rango', data.deposits_withdrawals.range.total_withdrawals],
      ['Depósitos', 'Net Deposit del rango', data.deposits_withdrawals.range.net_deposit],
      ['Depósitos', 'Net Deposit del mes', monthNet],
      ['Depósitos', 'Net Deposit mes anterior', prevNet],
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

  const handleExportPDF = () => verify2FA(() => {
    if (!data) return;
    const headers = ['Métrica', 'Valor'];
    const rows: (string | number)[][] = [
      ['Período', `${formatDate(from)} — ${formatDate(to)}`],
      ['Total depósitos del rango', data.deposits_withdrawals.range.total_deposits],
      ['Total retiros del rango', data.deposits_withdrawals.range.total_withdrawals],
      ['Net Deposit del rango', data.deposits_withdrawals.range.net_deposit],
      ['Net Deposit del mes', monthNet],
      ['Net Deposit mes anterior', prevNet],
      ['Nuevos usuarios (rango)', data.crm_users.new_users_in_range],
      ['Nuevos usuarios (mes)', data.crm_users.new_users_this_month],
      ['Total usuarios', data.crm_users.total_users],
      ['Broker P&L (rango)', data.broker_pnl.pnl_range],
      ['Broker P&L (mes)', data.broker_pnl.pnl_month],
      ['Broker P&L (mes anterior)', data.broker_pnl.pnl_prev_month],
      ['Ventas Prop Firm (rango)', data.prop_trading.total_sales_range],
      ['Retiros Prop Firm (rango)', data.prop_trading.prop_withdrawals_range],
      ['P&L Prop Firm (rango)', data.prop_trading.pnl_range],
    ];
    downloadPDF('Reporte Financiero', headers, rows, {
      companyName: company?.name ?? 'Smart Dashboard',
      subtitle: `Período: ${formatDate(from)} — ${formatDate(to)}`,
      date: formatDate(new Date()),
    });
  });

  // ── Render ─────────────────────────────────────────────────────────

  if (!canAccess) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Sin acceso al módulo de Reportes</p>
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

      <PageHeader
        title="Reportes"
        subtitle="Resumen operativo por período"
        icon={BarChart3}
        actions={
          <div className="flex gap-2">
            <button
              onClick={handleExportCSV}
              disabled={!data}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
            >
              <FileSpreadsheet className="w-4 h-4" /> CSV
            </button>
            <button
              onClick={handleExportPDF}
              disabled={!data}
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
              <span className="text-muted-foreground">Desde</span>
              <input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setActiveQuickRange(null);
                }}
                className="px-2 py-1 rounded-md border border-border bg-background text-sm"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Hasta</span>
              <input
                type="date"
                value={to}
                max={todayISO()}
                onChange={(e) => {
                  setTo(e.target.value);
                  setActiveQuickRange(null);
                }}
                className="px-2 py-1 rounded-md border border-border bg-background text-sm"
              />
            </label>
            <button
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-sm hover:bg-muted"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Actualizar
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
                {r === 'today' && 'Hoy'}
                {r === 'yesterday' && 'Ayer'}
                {r === 'last7' && 'Últimos 7 días'}
                {r === 'thisMonth' && 'Este mes'}
                {r === 'prevMonth' && 'Mes anterior'}
              </button>
            ))}
          </div>
        </div>
        {anyMock && (
          <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">
            · Algunos datos provienen de <strong>mock</strong> (Orion CRM sin credenciales). Configúralas en{' '}
            <em>Superadmin → Empresa → APIs externas</em> para ver datos reales.
          </p>
        )}
      </Card>

      {error && (
        <Card className="bg-red-50 dark:bg-red-950/40 border-red-300 dark:border-red-800">
          <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
        </Card>
      )}

      {loading && !data && <Skeleton />}

      {data && (
        <>
          {/* SECTION 1 — Deposits & Withdrawals */}
          <Card>
            <div className="flex items-center gap-2 mb-4">
              <Wallet className="w-5 h-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Depósitos y Retiros</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              {/* Deposits by channel */}
              <div>
                <h3 className="text-sm font-medium mb-2">Depósitos por canal</h3>
                <TableList
                  rows={data.deposits_withdrawals.range.deposits.map((d) => ({
                    label: CHANNEL_LABEL[d.channel] ?? d.channel,
                    count: d.count,
                    amount: d.amount,
                  }))}
                  totalAmount={data.deposits_withdrawals.range.total_deposits}
                  emptyLabel="Sin depósitos en el período"
                />
              </div>

              {/* Withdrawals by category */}
              <div>
                <h3 className="text-sm font-medium mb-2">Retiros por categoría</h3>
                <TableList
                  rows={data.deposits_withdrawals.range.withdrawals.map((w) => ({
                    label: CATEGORY_LABEL[w.category] ?? w.category,
                    count: w.count,
                    amount: w.amount,
                  }))}
                  totalAmount={data.deposits_withdrawals.range.total_withdrawals}
                  emptyLabel="Sin retiros en el período"
                />
              </div>
            </div>

            {/* Range net + monthly context */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatCard
                label="Net Deposit del rango"
                value={formatCurrency(rangeNet)}
                tone={rangeNet >= 0 ? 'positive' : 'negative'}
                hint={
                  netRangePctOfMonth === null
                    ? 'sin referencia mensual'
                    : `${Math.round(netRangePctOfMonth * 10) / 10}% del mes actual`
                }
              />
              <StatCard
                label="Net Deposit mes actual"
                value={formatCurrency(monthNet)}
                tone={monthNet >= 0 ? 'positive' : 'negative'}
                hint={<VariationBadge pct={monthVsPrev} />}
              />
              <StatCard
                label="Net Deposit mes anterior"
                value={formatCurrency(prevNet)}
                tone="neutral"
              />
            </div>
          </Card>

          {/* SECTION 2 — CRM Users */}
          <Card>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-muted-foreground" />
                <h2 className="text-lg font-semibold">Usuarios CRM</h2>
              </div>
              {data.crm_users.isMock && <Badge variant="warning">· mock</Badge>}
            </div>
            {!data.crm_users.connected && !data.crm_users.isMock ? (
              <NotConnectedNotice />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard
                  label="Nuevos en el rango"
                  value={data.crm_users.new_users_in_range.toLocaleString('es')}
                  tone="info"
                />
                <StatCard
                  label="Nuevos este mes"
                  value={data.crm_users.new_users_this_month.toLocaleString('es')}
                  tone="info"
                />
                <StatCard
                  label="Total en plataforma"
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
                <h2 className="text-lg font-semibold">Broker P&L</h2>
              </div>
              {data.broker_pnl.isMock && <Badge variant="warning">· mock</Badge>}
            </div>
            {!data.broker_pnl.connected && !data.broker_pnl.isMock ? (
              <NotConnectedNotice />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard
                  label="P&L del rango"
                  value={formatCurrency(data.broker_pnl.pnl_range)}
                  tone={data.broker_pnl.pnl_range >= 0 ? 'positive' : 'negative'}
                  hint={
                    brokerPnlRangePctOfMonth === null
                      ? 'sin referencia mensual'
                      : `${Math.round(brokerPnlRangePctOfMonth * 10) / 10}% del mes actual`
                  }
                />
                <StatCard
                  label="P&L mes actual"
                  value={formatCurrency(data.broker_pnl.pnl_month)}
                  tone={data.broker_pnl.pnl_month >= 0 ? 'positive' : 'negative'}
                  hint={<VariationBadge pct={brokerPnlMonthVsPrev} />}
                />
                <StatCard
                  label="P&L mes anterior"
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
                <h2 className="text-lg font-semibold">Prop Trading Firm</h2>
              </div>
              {data.prop_trading.isMock && <Badge variant="warning">· mock</Badge>}
            </div>

            {!data.prop_trading.connected && !data.prop_trading.isMock ? (
              <NotConnectedNotice />
            ) : (
              <>
            {/* Products table */}
            <div className="mb-4">
              <h3 className="text-sm font-medium mb-2">Productos vendidos en el rango</h3>
              {data.prop_trading.products.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3">
                  Sin ventas en el período seleccionado
                </p>
              ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Producto</th>
                        <th className="text-right px-3 py-2 font-medium">Cantidad</th>
                        <th className="text-right px-3 py-2 font-medium">Monto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.prop_trading.products.map((p) => (
                        <tr key={p.name} className="border-t border-border">
                          <td className="px-3 py-2">{p.name}</td>
                          <td className="px-3 py-2 text-right">{p.quantity}</td>
                          <td className="px-3 py-2 text-right">{formatCurrency(p.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-muted/30 font-medium">
                      <tr className="border-t border-border">
                        <td className="px-3 py-2">Total</td>
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
                label="Ventas del rango"
                value={formatCurrency(data.prop_trading.total_sales_range)}
                tone="info"
                hint={`Mes: ${formatCurrency(data.prop_trading.total_sales_month)}`}
              />
              <StatCard
                label="Retiros Prop Firm"
                value={formatCurrency(data.prop_trading.prop_withdrawals_range)}
                tone="warning"
                hint={`${data.prop_trading.prop_withdrawals_count_range} retiros`}
              />
              <StatCard
                label="P&L del rango"
                value={formatCurrency(data.prop_trading.pnl_range)}
                tone={data.prop_trading.pnl_range >= 0 ? 'positive' : 'negative'}
                hint={
                  propPnlRangePctOfMonth === null
                    ? 'sin referencia mensual'
                    : `${Math.round(propPnlRangePctOfMonth * 10) / 10}% del mes`
                }
              />
            </div>

            {/* Monthly comparison */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
              <StatCard
                label="P&L Prop Firm — mes actual"
                value={formatCurrency(data.prop_trading.pnl_month)}
                tone={data.prop_trading.pnl_month >= 0 ? 'positive' : 'negative'}
                hint={<VariationBadge pct={propPnlMonthVsPrev} />}
              />
              <StatCard
                label="P&L Prop Firm — mes anterior"
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
          Sin datos para el período seleccionado.{' '}
          <button
            onClick={() => void load()}
            className="underline text-[var(--color-primary)]"
          >
            Reintentar
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
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-3">{emptyLabel}</p>;
  }
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Canal / Cat</th>
            <th className="text-right px-3 py-2 font-medium">#</th>
            <th className="text-right px-3 py-2 font-medium">Monto</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-border">
              <td className="px-3 py-2">{r.label}</td>
              <td className="px-3 py-2 text-right">{r.count}</td>
              <td className="px-3 py-2 text-right font-medium">{formatCurrency(r.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-muted/30 font-semibold">
          <tr className="border-t border-border">
            <td className="px-3 py-2">Total</td>
            <td></td>
            <td className="px-3 py-2 text-right">{formatCurrency(totalAmount)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function NotConnectedNotice() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center">
      <p className="text-sm font-medium text-foreground">Orion CRM no conectado</p>
      <p className="text-xs text-muted-foreground mt-1">
        Configura las credenciales en <em>Superadmin → Empresa → APIs externas</em> para ver datos reales.
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
