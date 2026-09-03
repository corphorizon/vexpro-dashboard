'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /ordenes-pago — listado del módulo de tesorería.
//
// La vista responde tres preguntas en este orden: ¿qué me está esperando a mí
// (pendientes de aprobación), qué ya está autorizado y todavía no salió
// (aprobadas sin pagar) y cuánto pagamos este mes. Después, la tabla.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { FileText, Plus, Search, Download, Eye, ClockAlert, CheckCheck, Banknote } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { useToasts } from '@/components/ui/toast';
import { StatusBadge } from '@/components/payment-orders/status-badge';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { roleCanWriteFinance } from '@/lib/roles';
import { useData } from '@/lib/data-context';
import { cn, formatCurrency } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import type { PaymentOrder, PaymentOrderStatus } from '@/lib/payment-orders/types';
// Firma asumida: listPaymentOrders(): Promise<PaymentOrder[]>
import { getPaymentOrder, listPaymentOrders } from '@/lib/payment-orders/api';

type Filter = 'all' | PaymentOrderStatus;

const FILTERS: { value: Filter; key: string }[] = [
  { value: 'all', key: 'payOrders.filterAll' },
  { value: 'draft', key: 'payOrders.filterDraft' },
  { value: 'pending', key: 'payOrders.filterPending' },
  { value: 'approved', key: 'payOrders.filterApproved' },
  { value: 'paid', key: 'payOrders.filterPaid' },
  { value: 'cancelled', key: 'payOrders.filterCancelled' },
];

export default function OrdenesPagoPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  // El servidor rechaza el alta a roles fuera de finanzas: no dibujar el botón.
  const canAct = roleCanWriteFinance(user?.effective_role ?? '');
  const { company } = useData();
  const { toast, ToastHost } = useToasts();

  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    listPaymentOrders()
      .then((rows) => {
        if (alive) setOrders(rows ?? []);
      })
      .catch((err: unknown) => {
        if (alive) toast.error(err instanceof Error ? err.message : t('payOrders.loadError'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // El toast/t son estables por render; se carga una vez por montaje.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const money = (n: number, currency?: string) =>
    formatCurrency(n, (currency === 'USDT' ? 'USD' : currency) || company?.currency || 'USD');

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const pending = orders.filter((o) => o.status === 'pending');
    const approved = orders.filter((o) => o.status === 'approved');
    const paidThisMonth = orders.filter(
      (o) => o.status === 'paid' && (o.paid_at ?? o.payment_date ?? '').slice(0, 7) === ym,
    );
    return {
      pendingCount: pending.length,
      pendingSum: pending.reduce((s, o) => s + (o.total ?? 0), 0),
      approvedCount: approved.length,
      approvedSum: approved.reduce((s, o) => s + (o.total ?? 0), 0),
      paidMonthSum: paidThisMonth.reduce((s, o) => s + (o.total ?? 0), 0),
      paidMonthCount: paidThisMonth.length,
    };
  }, [orders]);

  // ── Filtro + búsqueda (todo client-side: el volumen de órdenes por empresa
  //    es de decenas, no vale un round-trip por tecla) ────────────────────────
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders
      .filter((o) => (filter === 'all' ? true : o.status === filter))
      .filter((o) =>
        q
          ? o.order_number.toLowerCase().includes(q) || (o.beneficiary_name ?? '').toLowerCase().includes(q)
          : true,
      )
      .sort((a, b) => (b.issue_date ?? '').localeCompare(a.issue_date ?? '') || b.order_number.localeCompare(a.order_number));
  }, [orders, filter, query]);

  async function downloadPdf(order: PaymentOrder) {
    setPdfBusy(order.id);
    try {
      // Import perezoso: jsPDF + el generador pesan, y la mayoría de las
      // visitas al listado nunca descargan un PDF.
      const { generatePaymentOrderPDF } = await import('@/lib/payment-orders/pdf');
      // El documento lleva la marca de la empresa: sin empresa activa no se emite.
      if (!company) throw new Error(t('payOrders.pdfError'));
      // El LISTADO no trae `proofs` ni `attachments` (no hace el join), y desde
      // que el PDF los índiza, generarlo con la fila del listado imprimiría una
      // orden "sin archivos" que sí los tiene — el fallo que no da error. Se
      // pide la orden completa (mismo endpoint que el detalle, mismo lector).
      const full = await getPaymentOrder(order.id);
      await generatePaymentOrderPDF(full, company, { download: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('payOrders.pdfError'));
    } finally {
      setPdfBusy(null);
    }
  }

  const hasAny = orders.length > 0;

  return (
    <div className="space-y-6">
      {ToastHost}
      <PageHeader
        title={t('payOrders.title')}
        subtitle={t('payOrders.subtitle')}
        icon={FileText}
        actions={
          canAct ? (
            <Link href="/ordenes-pago/nueva">
              <Button variant="primary">
                <Plus className="w-4 h-4" />
                {t('payOrders.new')}
              </Button>
            </Link>
          ) : undefined
        }
      />

      {loading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-10 w-full max-w-md" />
          <Skeleton className="h-80" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard
              label={t('payOrders.kpiPending')}
              value={kpis.pendingCount}
              hint={kpis.pendingCount > 0 ? money(kpis.pendingSum) : t('payOrders.kpiPendingNone')}
              icon={ClockAlert}
              tone="warning"
            />
            <StatCard
              label={t('payOrders.kpiApproved')}
              value={money(kpis.approvedSum)}
              hint={t('payOrders.kpiApprovedHint', { count: String(kpis.approvedCount) })}
              icon={CheckCheck}
              tone="info"
            />
            <StatCard
              label={t('payOrders.kpiPaidMonth')}
              value={money(kpis.paidMonthSum)}
              hint={t('payOrders.kpiPaidMonthHint', { count: String(kpis.paidMonthCount) })}
              icon={Banknote}
              tone="positive"
            />
          </div>

          <div className="flex flex-col lg:flex-row lg:items-center gap-3">
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((f) => {
                const count =
                  f.value === 'all' ? orders.length : orders.filter((o) => o.status === f.value).length;
                return (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => setFilter(f.value)}
                    aria-pressed={filter === f.value}
                    className={cn(
                      'px-3 py-1.5 text-xs font-medium rounded-md border transition-colors',
                      filter === f.value
                        ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                        : 'border-border hover:bg-muted',
                    )}
                  >
                    {t(f.key)}
                    <span className="ml-1.5 tabular-nums opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>
            <div className="relative lg:ml-auto lg:w-72">
              <Search
                className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                aria-hidden
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('payOrders.searchPlaceholder')}
                aria-label={t('payOrders.searchPlaceholder')}
                className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm"
              />
            </div>
          </div>

          <Card className="p-0 overflow-hidden">
            <DataTable
              data={filtered}
              stickyHeader
              zebra
              columns={[
                {
                  header: t('payOrders.colNumber'),
                  accessor: (o) => (
                    <Link
                      href={`/ordenes-pago/${o.id}`}
                      className="font-mono text-sm font-medium text-primary dark:text-accent hover:underline"
                    >
                      {o.order_number}
                    </Link>
                  ),
                },
                { header: t('payOrders.colIssueDate'), accessor: (o) => formatDate(o.issue_date) },
                {
                  header: t('payOrders.colBeneficiary'),
                  accessor: (o) => <span className="font-medium">{o.beneficiary_name || '—'}</span>,
                },
                {
                  header: t('payOrders.colMethod'),
                  accessor: (o) => <MethodChip order={o} bankLabel={t('payOrders.methodBank')} />,
                },
                {
                  header: t('payOrders.colTotal'),
                  align: 'right',
                  accessor: (o) => (
                    <span className="font-semibold tabular-nums">{money(o.total ?? 0, o.currency)}</span>
                  ),
                },
                { header: t('payOrders.colStatus'), accessor: (o) => <StatusBadge status={o.status} /> },
                {
                  header: t('payOrders.colActions'),
                  align: 'right',
                  accessor: (o) => (
                    <div className="flex items-center justify-end gap-1">
                      <Link href={`/ordenes-pago/${o.id}`}>
                        <Button variant="ghost" size="icon" aria-label={`${t('payOrders.view')} ${o.order_number}`}>
                          <Eye className="w-4 h-4" />
                        </Button>
                      </Link>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${t('payOrders.downloadPdf')} ${o.order_number}`}
                        loading={pdfBusy === o.id}
                        onClick={() => downloadPdf(o)}
                      >
                        <Download className="w-4 h-4" />
                      </Button>
                    </div>
                  ),
                },
              ]}
              empty={
                hasAny ? (
                  <EmptyState
                    compact
                    icon={Search}
                    title={t('payOrders.emptyFilteredTitle')}
                    description={t('payOrders.emptyFilteredDesc')}
                  />
                ) : (
                  <EmptyState
                    icon={FileText}
                    title={t('payOrders.emptyTitle')}
                    description={t('payOrders.emptyDesc')}
                    action={
                      canAct ? (
                        <Link href="/ordenes-pago/nueva">
                          <Button variant="primary">
                            <Plus className="w-4 h-4" />
                            {t('payOrders.new')}
                          </Button>
                        </Link>
                      ) : undefined
                    }
                  />
                )
              }
            />
          </Card>
        </>
      )}
    </div>
  );
}

/** Chip compacto de medio de pago: "USDT · TRC20" o "Banco". */
function MethodChip({ order, bankLabel }: { order: PaymentOrder; bankLabel: string }) {
  if (order.payment_method === 'bank') {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-muted text-xs font-medium text-muted-foreground">
        {bankLabel}
      </span>
    );
  }
  // "TRC20 (Tron)" → "TRC20": en la tabla solo importa la red, no el paréntesis.
  const short = (order.crypto_network ?? '').split(' ')[0];
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-info/10 text-xs font-medium text-info">
      USDT{short ? ` · ${short}` : ''}
    </span>
  );
}
