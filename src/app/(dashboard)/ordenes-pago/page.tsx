'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /ordenes-pago — listado del módulo de tesorería.
//
// La vista responde tres preguntas en este orden: ¿qué me está esperando a mí
// (pendientes de aprobación), qué ya está autorizado y todavía no salió
// (aprobadas sin pagar) y cuánto pagamos / comprometimos este mes. Después,
// el libro.
//
// «Libro mayor» (2026-10-12, docs/diseno-libro-mayor.md):
//   · KpiStrip en vez de tres StatCard con íconos de color: el «Pendientes»
//     es el hero (lo único que pide una acción) y el color queda para el
//     significado (spec §2.1).
//   · Segmented por estado con conteos — ahora con «Rechazadas», que faltaba
//     (los filtros salen de la máquina de estados, orders-view.ts) —, chips
//     por medio y por beneficiario, buscador.
//   · FinTable: Nº mono, beneficiario + concepto como meta, monto a la
//     derecha con <Money>, acciones al hover; en < 720 px, filas-tarjeta con
//     estado y número bajo el nombre.
//   · Recorte contado: el endpoint corta sin avisar (200 por defecto). Se pide
//     el máximo y, si vuelve lleno, un aviso `pend` y el pie de la tabla lo
//     dicen con el número (reglas-del-proyecto.md §1.2).
//   · Monedas: los KPIs y el total del pie suman sólo la moneda de la empresa
//     (USDT ≡ USD) y cuentan el resto — antes sumaban todo junto.
//
// Medición de la migración (colores fuera de tokens en este archivo): antes
// 1 paleta cruda (`text-white`), 1 `dark:` de color, 2 `[var(--color-primary)]`,
// 7 tokens legados (`text-negative`, `bg-info/10`, `bg-muted`…); después 0.
//
// DESCARTADO: paginar en el cliente. Son decenas de órdenes por empresa (el
// tope del endpoint es 500) y FinTable con `maxHeight` deja la cabecera y el
// total pegados; una página de 25 escondería el resto detrás de un clic.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Download, Eye, FileText, Landmark, Plus, Search, Trash2, Wallet, X } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { Segmented } from '@/components/ui/segmented';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS, moneyText } from '@/components/ui/money';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useToasts } from '@/components/ui/toast';
import { StatusBadge, useStatusLabel } from '@/components/payment-orders/status-badge';
import { ROW_ACTION_CLASS, actionButtonClass } from '@/components/payment-orders/action-button';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { roleCanPreparePaymentOrder, roleCanWriteFinance } from '@/lib/roles';
import { useData } from '@/lib/data-context';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dates';
import type { PaymentMethod, PaymentOrder } from '@/lib/payment-orders/types';
import { deletePaymentOrder, getPaymentOrder, listPaymentOrders } from '@/lib/payment-orders/api';
import { deleteConfirmKind, type DeletedOrderSummary } from '@/lib/payment-orders/delete';
import {
  LIST_LIMIT,
  NO_CHIPS,
  STATUS_FILTERS,
  applySearchAndChips,
  beneficiaryChips,
  beneficiaryKey,
  filterOrders,
  isListTruncated,
  methodCounts,
  normCurrency,
  orderConcept,
  orderKpis,
  statusCounts,
  sumInCurrency,
  sumOrNull,
  type ChipFilters,
  type MoneySum,
  type StatusFilter,
} from './orders-view';

/** Clave i18n de cada filtro. `Record` sobre StatusFilter: un estado nuevo sin etiqueta no compila. */
const FILTER_KEY: Record<StatusFilter, string> = {
  all: 'payOrders.filterAll',
  draft: 'payOrders.filterDraft',
  pending: 'payOrders.filterPending',
  approved: 'payOrders.filterApproved',
  paid: 'payOrders.filterPaid',
  rejected: 'payOrders.filterRejected',
  cancelled: 'payOrders.filterCancelled',
};

const METHODS: readonly PaymentMethod[] = ['crypto', 'bank'];

export default function OrdenesPagoPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { user } = useAuth();
  // El servidor rechaza el alta a roles fuera de finanzas: no dibujar el botón.
  const canAct = roleCanWriteFinance(user?.effective_role ?? '');
  // Preparar ≠ decidir (roles.ts, 2026-10-05): RRHH crea y envía; borrar,
  // aprobar y pagar siguen siendo de finanzas (`canAct`).
  const canPrepare = roleCanPreparePaymentOrder(user?.effective_role ?? '');
  const { company } = useData();
  const { toast, ToastHost } = useToasts();
  const statusLabel = useStatusLabel();

  const [orders, setOrders] = useState<PaymentOrder[]>([]);
  const [received, setReceived] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [chips, setChips] = useState<ChipFilters>(NO_CHIPS);
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null);
  // El «ahora» de los KPIs del mes se toma una vez al montar (no en cada render).
  const [now] = useState(() => new Date());

  const companyCurrency = normCurrency(company?.currency);

  async function fetchOrders(): Promise<PaymentOrder[]> {
    const rows = (await listPaymentOrders({ limit: LIST_LIMIT })) ?? [];
    setReceived(rows.length);
    return rows;
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchOrders()
      .then((rows) => {
        if (alive) setOrders(rows);
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

  const truncated = isListTruncated(received);
  const kpis = useMemo(() => orderKpis(orders, now, companyCurrency), [orders, now, companyCurrency]);

  // ── Filtros: búsqueda + chips → conteos por estado → estado ───────────────
  const searched = useMemo(() => applySearchAndChips(orders, query, chips), [orders, query, chips]);
  const counts = useMemo(() => statusCounts(searched), [searched]);
  const filtered = useMemo(
    () => filterOrders(orders, { status: filter, query, chips }),
    [orders, filter, query, chips],
  );
  // Los chips cuentan sobre búsqueda + estado (sin los propios chips), así el
  // número del chip dice cuántas filas suma si lo prendés.
  const chipBase = useMemo(() => {
    const base = applySearchAndChips(orders, query, NO_CHIPS);
    return filter === 'all' ? base : base.filter((o) => o.status === filter);
  }, [orders, query, filter]);
  const methodN = useMemo(() => methodCounts(chipBase), [chipBase]);
  // La lista de beneficiarios sale de TODAS las órdenes (no salta al filtrar).
  const benChips = useMemo(() => beneficiaryChips(orders, 5), [orders]);
  const benN = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of chipBase) m.set(beneficiaryKey(o), (m.get(beneficiaryKey(o)) ?? 0) + 1);
    return m;
  }, [chipBase]);
  const footerSum = useMemo(() => sumInCurrency(filtered, companyCurrency), [filtered, companyCurrency]);

  const fmt = (n: number, currency?: string | null) =>
    moneyText(n, { currency: normCurrency(currency, companyCurrency) });

  function toggleMethod(m: PaymentMethod) {
    setChips((prev) => ({
      ...prev,
      methods: prev.methods.includes(m) ? prev.methods.filter((x) => x !== m) : [...prev.methods, m],
    }));
  }

  function toggleBeneficiary(key: string) {
    setChips((prev) => ({
      ...prev,
      beneficiaries: prev.beneficiaries.includes(key)
        ? prev.beneficiaries.filter((x) => x !== key)
        : [...prev.beneficiaries, key],
    }));
  }

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
      lines.push(t('payOrders.deleteDoneExpense', { amount: fmt(amount, r.orden.currency) }));
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
      total: fmt(order.total ?? 0, order.currency),
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
        setOrders(await fetchOrders());
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('payOrders.loadError'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('payOrders.deleteError'));
    } finally {
      setDeleteBusy(null);
    }
  }

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const otherNote = (s: MoneySum) =>
    s.otherCurrency > 0 ? t('payOrders.kpiOtherCurrency', { count: String(s.otherCurrency) }) : null;
  const joinSub = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ');

  const kpiItems: KpiItem[] = [
    {
      key: 'pending',
      label: t('payOrders.kpiPending'),
      value: sumOrNull(kpis.pending),
      currency: companyCurrency,
      hero: true,
      sub: joinSub(
        kpis.pending.count > 0
          ? t('payOrders.kpiPendingHint', { count: String(kpis.pending.count) })
          : t('payOrders.kpiPendingNone'),
        otherNote(kpis.pending),
      ),
    },
    {
      key: 'approved',
      label: t('payOrders.kpiApproved'),
      value: sumOrNull(kpis.approved),
      currency: companyCurrency,
      sub: joinSub(
        t('payOrders.kpiApprovedHint', { count: String(kpis.approved.count) }),
        otherNote(kpis.approved),
      ),
    },
    {
      key: 'paidMonth',
      label: t('payOrders.kpiPaidMonth'),
      value: sumOrNull(kpis.paidMonth),
      currency: companyCurrency,
      sub: joinSub(
        t('payOrders.kpiPaidMonthHint', { count: String(kpis.paidMonth.count) }),
        otherNote(kpis.paidMonth),
      ),
    },
    {
      key: 'monthTotal',
      label: t('payOrders.kpiMonthTotal'),
      value: sumOrNull(kpis.monthTotal),
      currency: companyCurrency,
      sub: joinSub(
        t('payOrders.kpiMonthTotalHint', { count: String(kpis.monthTotal.count) }),
        otherNote(kpis.monthTotal),
      ),
    },
  ];

  // ── Columnas ──────────────────────────────────────────────────────────────
  const columns: FinColumn<PaymentOrder>[] = [
    {
      key: 'number',
      header: t('payOrders.colNumber'),
      hideSm: true,
      width: '128px',
      cell: (o) => (
        <Link
          href={`/ordenes-pago/${o.id}`}
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-[12px] font-medium text-foreground hover:underline"
        >
          {o.order_number}
        </Link>
      ),
    },
    {
      key: 'beneficiary',
      header: t('payOrders.colBeneficiary'),
      cell: (o) => o.beneficiary_name || '—',
      meta: (o) => orderConcept(o) ?? '',
      mobileMeta: (o) => (
        <>
          <StatusBadge status={o.status} />
          <span className="font-mono">{o.order_number}</span>
          <span className={NUM_CLASS}>{formatDate(o.created_at)}</span>
        </>
      ),
    },
    {
      key: 'method',
      header: t('payOrders.colMethod'),
      hideSm: true,
      cell: (o) => <MethodLabel order={o} bankLabel={t('payOrders.methodBank')} />,
    },
    {
      key: 'status',
      header: t('payOrders.colStatus'),
      hideSm: true,
      cell: (o) => <StatusBadge status={o.status} />,
    },
    {
      key: 'amount',
      header: t('payOrders.colAmount'),
      kind: 'money',
      value: (o) => o.total,
      money: { currency: companyCurrency },
      cell: (o) => (
        <Money
          value={o.total}
          currency={normCurrency(o.currency, companyCurrency)}
          nullLabel={t('ui.noData')}
          className="font-medium"
        />
      ),
    },
    {
      key: 'created',
      header: t('payOrders.colCreated'),
      hideSm: true,
      width: '112px',
      cell: (o) => <span className={cn(NUM_CLASS, 'text-text-2')}>{formatDate(o.created_at)}</span>,
    },
  ];

  const rowActions = (o: PaymentOrder) => (
    <>
      <Link
        href={`/ordenes-pago/${o.id}`}
        className={ROW_ACTION_CLASS}
        title={t('payOrders.view')}
        aria-label={`${t('payOrders.view')} ${o.order_number}`}
      >
        <Eye aria-hidden className="size-4" strokeWidth={1.75} />
      </Link>
      <button
        type="button"
        className={ROW_ACTION_CLASS}
        title={t('payOrders.downloadPdf')}
        aria-label={`${t('payOrders.downloadPdf')} ${o.order_number}`}
        aria-busy={pdfBusy === o.id || undefined}
        disabled={pdfBusy === o.id}
        onClick={() => downloadPdf(o)}
      >
        <Download aria-hidden className={cn('size-4', pdfBusy === o.id && 'animate-pulse')} strokeWidth={1.75} />
      </button>
      {canAct && (
        <button
          type="button"
          className={cn(ROW_ACTION_CLASS, 'hover:text-neg')}
          title={t('payOrders.delete')}
          aria-label={`${t('payOrders.delete')} ${o.order_number}`}
          aria-busy={deleteBusy === o.id || undefined}
          disabled={deleteBusy !== null}
          onClick={() => removeOrder(o)}
        >
          <Trash2 aria-hidden className="size-4" strokeWidth={1.75} />
        </button>
      )}
    </>
  );

  const hasAny = orders.length > 0;
  const footerLabel =
    footerSum.otherCurrency > 0
      ? t('payOrders.listFooterPartial', {
          shown: String(footerSum.count - footerSum.otherCurrency),
          n: String(footerSum.count),
          other: String(footerSum.otherCurrency),
        })
      : t('payOrders.listFooter', { n: String(footerSum.count) });

  const newButton = canPrepare ? (
    <Link href="/ordenes-pago/nueva" className={actionButtonClass('primary')}>
      <Plus aria-hidden className="size-4" />
      {t('payOrders.new')}
    </Link>
  ) : undefined;

  return (
    <div className="space-y-4">
      {ToastHost}
      <PageHeader title={t('payOrders.title')} subtitle={t('payOrders.subtitle')} icon={FileText} actions={newButton} />

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-[92px]" />
          <Skeleton className="h-10 w-full max-w-xl" />
          <Skeleton className="h-80" />
        </div>
      ) : (
        <>
          <KpiStrip items={kpiItems} />

          {truncated && (
            <Notice kind="pend" title={t('payOrders.truncatedTitle', { n: String(received) })}>
              {t('payOrders.truncatedBody', { n: String(received) })}
            </Notice>
          )}

          <Panel
            flush
            footer={truncated ? t('payOrders.truncatedFoot', { n: String(received) }) : undefined}
          >
            {/* Estado + búsqueda */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <div className="max-w-full overflow-x-auto">
                <Segmented<StatusFilter>
                  aria-label={t('payOrders.statusFilterAria')}
                  value={filter}
                  onChange={setFilter}
                  options={STATUS_FILTERS.map((f) => ({ value: f, label: t(FILTER_KEY[f]), count: counts[f] }))}
                />
              </div>
              <div className="relative ml-auto flex min-w-[220px] max-w-[320px] flex-1 items-center max-sm:max-w-none">
                <Search aria-hidden className="pointer-events-none absolute left-2.5 size-[15px] text-text-3" />
                <Input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('payOrders.searchPlaceholder')}
                  aria-label={t('payOrders.searchPlaceholder')}
                  className="pl-8 pr-8"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="absolute right-1.5 inline-flex size-6 items-center justify-center rounded-ui-sm text-text-3 hover:text-foreground"
                    aria-label={t('payOrders.clearSearch')}
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                )}
              </div>
            </div>

            {/* Chips: medio de pago y beneficiarios frecuentes */}
            {hasAny && (
              <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                {METHODS.filter((m) => methodN[m] > 0 || chips.methods.includes(m)).map((m) => (
                  <Chip
                    key={m}
                    icon={m === 'crypto' ? Wallet : Landmark}
                    active={chips.methods.includes(m)}
                    count={methodN[m]}
                    onClick={() => toggleMethod(m)}
                  >
                    {m === 'crypto' ? t('payOrders.methodCryptoFull') : t('payOrders.methodBankFull')}
                  </Chip>
                ))}
                {benChips.chips.length > 0 && <span aria-hidden className="mx-1 h-4 w-px bg-border" />}
                {benChips.chips.map((b) => (
                  <Chip
                    key={b.key}
                    active={chips.beneficiaries.includes(b.key)}
                    count={benN.get(b.key) ?? 0}
                    onClick={() => toggleBeneficiary(b.key)}
                    className="max-w-[220px]"
                  >
                    <span className="truncate">{b.label}</span>
                  </Chip>
                ))}
                {benChips.hidden > 0 && (
                  <span className="text-[12.5px] text-text-3">
                    {t('payOrders.benMore', { count: String(benChips.hidden) })}
                  </span>
                )}
              </div>
            )}

            <FinTable
              caption={t('payOrders.title')}
              columns={columns}
              rows={filtered}
              rowKey={(o) => o.id}
              onRowClick={(o) => router.push(`/ordenes-pago/${o.id}`)}
              rowActions={rowActions}
              maxHeight="70vh"
              footer={
                filtered.length > 0
                  ? {
                      label: footerLabel,
                      values: { amount: sumOrNull(footerSum) },
                    }
                  : undefined
              }
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
                    action={newButton}
                  />
                )
              }
            />
          </Panel>
        </>
      )}
    </div>
  );
}

/** Medio de pago en gris (no es un estado: no lleva color). «USDT · TRC20» o «Banco». */
function MethodLabel({ order, bankLabel }: { order: PaymentOrder; bankLabel: string }) {
  if (order.payment_method === 'bank') {
    return <span className="text-[12.5px] text-text-2">{bankLabel}</span>;
  }
  // "TRC20 (Tron)" → "TRC20": en la tabla solo importa la red, no el paréntesis.
  const short = (order.crypto_network ?? '').split(' ')[0];
  return (
    <span className="text-[12.5px] text-text-2">
      USDT{short ? <span className="text-text-3"> · {short}</span> : null}
    </span>
  );
}
