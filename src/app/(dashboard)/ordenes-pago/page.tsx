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
import { FileText, Plus, Search, Download, Eye, ClockAlert, CheckCheck, Banknote, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatCard } from '@/components/ui/stat-card';
import { Skeleton } from '@/components/ui/skeleton';
import { useToasts } from '@/components/ui/toast';
import { StatusBadge, useStatusLabel } from '@/components/payment-orders/status-badge';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { roleCanWriteFinance } from '@/lib/roles';
import { useData } from '@/lib/data-context';
import { cn, formatCurrency } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import type { PaymentOrder, PaymentOrderStatus } from '@/lib/payment-orders/types';
// Firma asumida: listPaymentOrders(): Promise<PaymentOrder[]>
import { deletePaymentOrder, getPaymentOrder, listPaymentOrders } from '@/lib/payment-orders/api';
import { deleteConfirmKind, type DeletedOrderSummary } from '@/lib/payment-orders/delete';

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
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null);
  const statusLabel = useStatusLabel();

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

  // ── Eliminar DEFINITIVAMENTE (pedido del dueño, 2026-10-01) ───────────────
  // Anular sigue siendo lo habitual; esto es para la orden que no debió
  // existir. El servidor es la autoridad (gate de rol, período cerrado,
  // egreso vinculado); acá solo se pide una confirmación que diga QUÉ se va
  // —número, total, estado y, si está pagada, que también se va su egreso— y
  // después se muestra el desglose que devuelve el servidor, sin resumirlo a
  // un "listo". La pantalla no usa verify2FA para nada (ni siquiera para
  // exportar), así que no se inventa acá un segundo patrón de confirmación.
  function deleteSummaryText(r: DeletedOrderSummary): string {
    const lines = [t('payOrders.deleteDone', { number: r.orden.order_number })];
    if (r.egresosBorrados.length > 0) {
      const amount = r.egresosBorrados.reduce((s, e) => s + e.amount, 0);
      lines.push(
        t('payOrders.deleteDoneExpense', { amount: money(amount, r.orden.currency) }),
      );
      // La trampa de replace_period_expenses (reglas §2.4): una pestaña de
      // Egresos/Carga abierta desde antes sigue MOSTRANDO la fila, pero la
      // migración 079 impide que guardar el mes la re-inserte. Se dice tal cual.
      lines.push(t('payOrders.deleteDoneStaleTabs'));
    } else if (r.orden.status === 'paid') {
      lines.push(t('payOrders.deleteDoneNoExpense'));
    }
    lines.push(
      t('payOrders.deleteDoneFiles', {
        proofs: String(r.adjuntosBorrados.comprobantes),
        attachments: String(r.adjuntosBorrados.respaldos),
      }),
    );
    if (r.archivosFallidos > 0) {
      lines.push(t('payOrders.deleteDoneFilesFailed', { count: String(r.archivosFallidos) }));
    }
    if (r.archivosPreservados > 0) {
      lines.push(t('payOrders.deleteDoneFilesKept', { count: String(r.archivosPreservados) }));
    }
    return lines.join('\n');
  }

  async function removeOrder(order: PaymentOrder) {
    const vars = {
      number: order.order_number,
      beneficiary: order.beneficiary_name || '—',
      total: money(order.total ?? 0, order.currency),
      status: statusLabel(order.status),
    };
    const message =
      deleteConfirmKind(order) === 'paid'
        ? t('payOrders.deleteConfirmPaid', vars)
        : t('payOrders.deleteConfirm', vars) +
          (order.status === 'cancelled' ? '' : `\n\n${t('payOrders.deleteConfirmVoidHint')}`);
    if (!window.confirm(message)) return;

    setDeleteBusy(order.id);
    try {
      const result = await deletePaymentOrder(order.id);
      // La fila ya no existe: se saca de la lista aunque el refresh falle, y
      // después se recarga del servidor para que KPIs y contadores salgan de
      // la verdad y no de un estado local parchado.
      setOrders((prev) => prev.filter((o) => o.id !== order.id));
      toast.success(deleteSummaryText(result));
      try {
        setOrders(await listPaymentOrders());
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('payOrders.loadError'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('payOrders.deleteError'));
    } finally {
      setDeleteBusy(null);
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
                      {canAct && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`${t('payOrders.delete')} ${o.order_number}`}
                          title={t('payOrders.delete')}
                          loading={deleteBusy === o.id}
                          disabled={deleteBusy !== null && deleteBusy !== o.id}
                          onClick={() => removeOrder(o)}
                          className="text-negative hover:text-negative"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
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
