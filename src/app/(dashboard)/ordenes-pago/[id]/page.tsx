'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /ordenes-pago/[id] — detalle de una orden de pago.
//
// Dos cosas mandan en esta pantalla:
//   1. La máquina de estados (canTransition) decide qué botones EXISTEN.
//   2. La segregación de funciones decide cuáles de esos están HABILITADOS:
//      solo un admin aprueba, y nunca quien creó la orden. El botón se muestra
//      deshabilitado con el motivo en vez de desaparecer — que el creador vea
//      que el control existe es parte del control.
//
// El historial no es decorativo: es la evidencia de tesorería (quién autorizó
// qué, cuándo y con qué referencia), por eso va completo y en orden.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Ban,
  CheckCheck,
  Download,
  FileText,
  History,
  Landmark,
  Pencil,
  Send,
  Wallet,
  X,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { useToasts } from '@/components/ui/toast';
import { StatusBadge } from '@/components/payment-orders/status-badge';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { cn, formatCurrency } from '@/lib/utils';
import { formatDate, formatDateTime } from '@/lib/dates';
import {
  canTransition,
  isEditable,
  type PaymentOrder,
  type PaymentOrderLine,
  type PaymentOrderStatus,
} from '@/lib/payment-orders/types';
import { getPaymentOrder, transitionPaymentOrder, type TransitionOptions } from '@/lib/payment-orders/api';

type Dialog = null | 'submit' | 'approve' | 'reject' | 'cancel' | 'pay' | 'reopen';

function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const INPUT =
  'w-full px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm placeholder:text-muted-foreground';

export default function OrdenPagoDetallePage() {
  const { t } = useI18n();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const router = useRouter();
  const { user } = useAuth();
  const { company } = useData();
  const { toast, ToastHost } = useToasts();

  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const row = await getPaymentOrder(id);
      setOrder(row ?? null);
    } catch {
      setOrder(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) load();
  }, [id, load]);

  const money = useCallback(
    (n: number) =>
      formatCurrency(n ?? 0, order?.currency === 'USDT' ? 'USD' : order?.currency || company?.currency || 'USD'),
    [order?.currency, company?.currency],
  );

  // ── Permisos ──────────────────────────────────────────────────────────────
  const isAdmin = user?.effective_role === 'admin' || user?.effective_role === 'superadmin';
  // created_by puede venir como company_users.id o como auth.users.id según el
  // camino de login; se comparan los dos para no fallar abierto.
  const isCreator = Boolean(
    order?.created_by && (order.created_by === user?.id || order.created_by === user?.auth_user_id),
  );
  const canApprove = isAdmin && !isCreator;
  const approveBlockedReason = !isAdmin
    ? t('payOrders.approveNeedsAdmin')
    : isCreator
      ? t('payOrders.makerChecker')
      : '';

  async function runTransition(to: PaymentOrderStatus, payload?: TransitionOptions) {
    if (!order) return;
    setBusy(true);
    try {
      const { order: updated, warning } = await transitionPaymentOrder(order.id, to, payload);
      setOrder(updated ?? order);
      setDialog(null);
      // `warning` = la transición se aplicó pero algo secundario no (típico:
      // pagada sin período abierto donde registrar el egreso). No es un error.
      if (warning) toast.info(warning);
      else toast.success(t('payOrders.transitionOk'));
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('payOrders.transitionError'));
    } finally {
      setBusy(false);
    }
  }

  async function downloadPdf() {
    if (!order) return;
    setPdfBusy(true);
    try {
      const { generatePaymentOrderPDF } = await import('@/lib/payment-orders/pdf');
      // El documento lleva la marca de la empresa: sin empresa activa no se emite.
      if (!company) throw new Error(t('payOrders.pdfError'));
      await generatePaymentOrderPDF(order, company, { download: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('payOrders.pdfError'));
    } finally {
      setPdfBusy(false);
    }
  }

  const timeline = useMemo(() => (order ? buildTimeline(order, t) : []), [order, t]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-12 w-72" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="h-96 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="space-y-6">
        <BackLink label={t('payOrders.backToList')} />
        <Card>
          <EmptyState
            icon={FileText}
            title={t('payOrders.notFoundTitle')}
            description={t('payOrders.notFoundDesc')}
            action={
              <Link href="/ordenes-pago">
                <Button variant="primary">{t('payOrders.backToList')}</Button>
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const crypto = order.payment_method === 'crypto';

  return (
    <div className="space-y-6">
      {ToastHost}
      <BackLink label={t('payOrders.backToList')} />

      {/* ── Cabecera ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-bold font-mono tracking-tight">{order.order_number}</h1>
            <StatusBadge status={order.status} />
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {t('payOrders.headerLine', {
              beneficiary: order.beneficiary_name || '—',
              date: formatDate(order.issue_date),
            })}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" onClick={downloadPdf} loading={pdfBusy}>
            <Download className="w-4 h-4" />
            {t('payOrders.downloadPdf')}
          </Button>

          {isEditable(order.status) && (
            <Link href={`/ordenes-pago/${order.id}/editar`}>
              <Button variant="secondary">
                <Pencil className="w-4 h-4" />
                {t('payOrders.edit')}
              </Button>
            </Link>
          )}

          {canTransition(order.status, 'pending') && (
            <Button variant="primary" onClick={() => setDialog('submit')}>
              <Send className="w-4 h-4" />
              {t('payOrders.submit')}
            </Button>
          )}

          {canTransition(order.status, 'approved') && (
            <span title={approveBlockedReason || undefined}>
              <Button variant="primary" disabled={!canApprove} onClick={() => setDialog('approve')}>
                <CheckCheck className="w-4 h-4" />
                {t('payOrders.approve')}
              </Button>
            </span>
          )}

          {canTransition(order.status, 'rejected') && (
            <span title={approveBlockedReason || undefined}>
              <Button variant="destructive" disabled={!canApprove} onClick={() => setDialog('reject')}>
                <X className="w-4 h-4" />
                {t('payOrders.reject')}
              </Button>
            </span>
          )}

          {canTransition(order.status, 'paid') && (
            <Button variant="primary" onClick={() => setDialog('pay')}>
              <Wallet className="w-4 h-4" />
              {t('payOrders.markPaid')}
            </Button>
          )}

          {canTransition(order.status, 'draft') && order.status !== 'draft' && (
            <Button variant="ghost" onClick={() => setDialog('reopen')}>
              {t('payOrders.reopen')}
            </Button>
          )}

          {canTransition(order.status, 'cancelled') && (
            <Button variant="ghost" onClick={() => setDialog('cancel')}>
              <Ban className="w-4 h-4" />
              {t('payOrders.void')}
            </Button>
          )}
        </div>
      </div>

      {approveBlockedReason && order.status === 'pending' && (
        <p className="text-xs text-muted-foreground">{approveBlockedReason}</p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2 space-y-6">
          {/* ── Datos de la orden ─────────────────────────────────────── */}
          <Card className="space-y-4">
            <h2 className="text-base font-semibold">{t('payOrders.sectionOrder')}</h2>
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <ReadField label={t('payOrders.issueDate')} value={formatDate(order.issue_date)} />
              <ReadField
                label={t('payOrders.paymentDate')}
                value={order.payment_date ? formatDate(order.payment_date) : '—'}
              />
              <ReadField label={t('payOrders.currency')} value={order.currency} />
              <ReadField
                label={t('payOrders.docLanguage')}
                value={order.locale === 'en' ? 'English' : 'Español'}
              />
            </dl>
          </Card>

          {/* ── Beneficiario ──────────────────────────────────────────── */}
          <Card className="space-y-4">
            <h2 className="text-base font-semibold">{t('payOrders.sectionBeneficiary')}</h2>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ReadField label={t('payOrders.benName')} value={order.beneficiary_name || '—'} strong />
              <ReadField label={t('payOrders.benTaxId')} value={order.beneficiary_tax_id || '—'} />
              <ReadField label={t('payOrders.benEmail')} value={order.beneficiary_email || '—'} />
              <ReadField label={t('payOrders.benCountry')} value={order.beneficiary_country || '—'} />
            </dl>
          </Card>

          {/* ── Detalle ───────────────────────────────────────────────── */}
          <Card className="space-y-4">
            <h2 className="text-base font-semibold">{t('payOrders.sectionLines')}</h2>
            <DataTable<PaymentOrderLine>
              data={order.lines ?? []}
              density="compact"
              columns={[
                { header: t('payOrders.lineDescription'), accessor: (l) => l.description || '—' },
                {
                  header: t('payOrders.lineUnitValue'),
                  align: 'right',
                  accessor: (l) => <span className="tabular-nums">{money(l.unitValue)}</span>,
                },
                {
                  header: t('payOrders.lineQuantity'),
                  align: 'right',
                  accessor: (l) => <span className="tabular-nums">{l.quantity}</span>,
                },
                {
                  header: t('payOrders.lineAmount'),
                  align: 'right',
                  accessor: (l) => <span className="font-medium tabular-nums">{money(l.amount)}</span>,
                },
              ]}
              empty={<EmptyState compact title={t('payOrders.noLines')} />}
            />
            <div className="border-t border-border pt-4 space-y-2">
              <TotalRow label={t('payOrders.subtotal')} value={money(order.subtotal)} />
              <TotalRow label={t('payOrders.fees')} value={money(order.fees)} />
              <div className="flex items-center justify-between sm:justify-end sm:gap-8 border-t border-border pt-3">
                <span className="text-sm font-semibold uppercase tracking-wide">{t('payOrders.total')}</span>
                <span className="text-2xl sm:text-3xl font-bold tabular-nums sm:w-48 sm:text-right">
                  {money(order.total)}
                </span>
              </div>
            </div>
          </Card>

          {/* ── Medio de pago ─────────────────────────────────────────── */}
          <Card className="space-y-4">
            <h2 className="text-base font-semibold flex items-center gap-2">
              {crypto ? <Wallet className="w-4 h-4 text-muted-foreground" /> : <Landmark className="w-4 h-4 text-muted-foreground" />}
              {t('payOrders.sectionMethod')}
            </h2>
            {crypto ? (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <ReadField label={t('payOrders.network')} value={order.crypto_network || '—'} />
                <ReadField label={t('payOrders.memo')} value={order.crypto_memo || '—'} mono />
                <div className="sm:col-span-2">
                  <ReadField label={t('payOrders.wallet')} value={order.crypto_wallet || '—'} mono breakAll />
                </div>
              </dl>
            ) : (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <ReadField label={t('payOrders.bankName')} value={order.bank_name || '—'} />
                <ReadField label={t('payOrders.accountHolder')} value={order.bank_account_holder || '—'} />
                <ReadField label={t('payOrders.accountNumber')} value={order.bank_account_number || '—'} mono breakAll />
                <ReadField label={t('payOrders.swift')} value={order.bank_swift || '—'} mono />
                <ReadField label={t('payOrders.accountType')} value={order.bank_account_type || '—'} />
              </dl>
            )}
          </Card>

          {/* ── Concepto ──────────────────────────────────────────────── */}
          <Card className="space-y-3">
            <h2 className="text-base font-semibold">{t('payOrders.sectionNotes')}</h2>
            <p className="text-sm whitespace-pre-line text-muted-foreground">{order.notes || '—'}</p>
          </Card>
        </div>

        {/* ── Historial ───────────────────────────────────────────────── */}
        <Card className="space-y-4 lg:sticky lg:top-4">
          <h2 className="text-base font-semibold flex items-center gap-2">
            <History className="w-4 h-4 text-muted-foreground" />
            {t('payOrders.timeline')}
          </h2>
          <ol className="space-y-4">
            {timeline.map((ev, i) => (
              <li key={i} className="relative pl-6">
                <span
                  className={cn(
                    'absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full',
                    ev.tone === 'positive' && 'bg-positive',
                    ev.tone === 'negative' && 'bg-negative',
                    ev.tone === 'warning' && 'bg-warning',
                    ev.tone === 'neutral' && 'bg-muted-foreground/50',
                  )}
                  aria-hidden
                />
                {i < timeline.length - 1 && (
                  <span className="absolute left-[4.5px] top-5 bottom-[-1rem] w-px bg-border" aria-hidden />
                )}
                <p className="text-sm font-medium leading-snug">{ev.title}</p>
                {ev.when && <p className="text-xs text-muted-foreground mt-0.5">{ev.when}</p>}
                {ev.detail && <p className="text-xs text-muted-foreground mt-1">{ev.detail}</p>}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      {/* ── Diálogos de transición ───────────────────────────────────────── */}
      {dialog === 'submit' && (
        <ConfirmDialog
          title={t('payOrders.submitTitle')}
          message={t('payOrders.submitMessage', { number: order.order_number })}
          confirmLabel={t('payOrders.submit')}
          onConfirm={() => runTransition('pending')}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === 'approve' && (
        <ConfirmDialog
          title={t('payOrders.approveTitle')}
          message={t('payOrders.approveMessage', {
            number: order.order_number,
            amount: money(order.total),
            beneficiary: order.beneficiary_name,
          })}
          confirmLabel={t('payOrders.approve')}
          onConfirm={() => runTransition('approved')}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === 'reopen' && (
        <ConfirmDialog
          title={t('payOrders.reopenTitle')}
          message={t('payOrders.reopenMessage')}
          confirmLabel={t('payOrders.reopen')}
          onConfirm={() => runTransition('draft')}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === 'reject' && (
        <ReasonDialog
          title={t('payOrders.rejectTitle')}
          description={t('payOrders.rejectDesc')}
          label={t('payOrders.reason')}
          confirmLabel={t('payOrders.reject')}
          errorLabel={t('payOrders.errReason')}
          tone="danger"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => runTransition('rejected', { reason })}
        />
      )}

      {dialog === 'cancel' && (
        <ReasonDialog
          title={t('payOrders.voidTitle')}
          description={t('payOrders.voidDesc')}
          label={t('payOrders.reason')}
          confirmLabel={t('payOrders.void')}
          errorLabel={t('payOrders.errReason')}
          tone="danger"
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => runTransition('cancelled', { reason })}
        />
      )}

      {dialog === 'pay' && (
        <PayDialog
          busy={busy}
          defaultDate={order.payment_date || todayISO()}
          onClose={() => setDialog(null)}
          onConfirm={(payload) => runTransition('paid', payload)}
        />
      )}
    </div>
  );
}

// ── Historial ───────────────────────────────────────────────────────────────

interface TimelineEvent {
  title: string;
  when?: string;
  detail?: string;
  tone: 'positive' | 'negative' | 'warning' | 'neutral';
}

function buildTimeline(o: PaymentOrder, t: (k: string, p?: Record<string, string>) => string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const who = (name: string | null) => name || t('payOrders.unknownUser');

  events.push({
    title: t('payOrders.tlCreated', { who: who(o.created_by_name) }),
    when: o.created_at ? formatDateTime(o.created_at) : undefined,
    tone: 'neutral',
  });
  if (o.submitted_at) {
    events.push({ title: t('payOrders.tlSubmitted'), when: formatDateTime(o.submitted_at), tone: 'warning' });
  }
  if (o.approved_at) {
    events.push({
      title: t('payOrders.tlApproved', { who: who(o.approved_by_name) }),
      when: formatDateTime(o.approved_at),
      tone: 'positive',
    });
  }
  if (o.rejected_at) {
    events.push({
      title: t('payOrders.tlRejected', { who: who(o.rejected_by_name) }),
      when: formatDateTime(o.rejected_at),
      detail: o.rejection_reason ? t('payOrders.tlReason', { reason: o.rejection_reason }) : undefined,
      tone: 'negative',
    });
  }
  if (o.paid_at) {
    events.push({
      title: t('payOrders.tlPaid', { who: who(o.paid_by_name) }),
      when: formatDateTime(o.paid_at),
      detail: o.payment_reference ? t('payOrders.tlReference', { ref: o.payment_reference }) : undefined,
      tone: 'positive',
    });
  }
  if (o.cancelled_at) {
    events.push({
      title: t('payOrders.tlCancelled', { who: who(o.cancelled_by_name) }),
      when: formatDateTime(o.cancelled_at),
      detail: o.cancellation_reason ? t('payOrders.tlReason', { reason: o.cancellation_reason }) : undefined,
      tone: 'negative',
    });
  }
  if (o.expense_id) {
    events.push({ title: t('payOrders.tlExpense'), tone: 'neutral' });
  }
  return events;
}

// ── Piezas de presentación ──────────────────────────────────────────────────

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href="/ordenes-pago"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
    >
      <ArrowLeft className="w-4 h-4" />
      {label}
    </Link>
  );
}

function ReadField({
  label,
  value,
  mono,
  strong,
  breakAll,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
  breakAll?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'mt-1 text-sm',
          mono && 'font-mono',
          strong && 'font-semibold',
          breakAll && 'break-all',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between sm:justify-end sm:gap-8">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums sm:w-48 sm:text-right">{value}</span>
    </div>
  );
}

/** Modal chico para transiciones que exigen un motivo escrito. */
function ReasonDialog({
  title,
  description,
  label,
  confirmLabel,
  errorLabel,
  tone,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  label: string;
  confirmLabel: string;
  errorLabel: string;
  tone: 'default' | 'danger';
  busy: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  return (
    <Modal title={title} onClose={busy ? () => {} : onClose}>
      <p className="text-sm text-muted-foreground">{description}</p>
      <label className="block">
        <span className="block text-sm font-medium mb-1.5">
          {label}
          <span className="text-negative"> *</span>
        </span>
        <textarea
          autoFocus
          rows={3}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError('');
          }}
          className={cn(INPUT, 'resize-y', error && 'border-negative')}
        />
        {error && <span className="block text-xs text-negative mt-1">{error}</span>}
      </label>
      <div className="flex justify-end gap-3 pt-2">
        <Button onClick={onClose} disabled={busy}>
          {t('payOrders.cancel')}
        </Button>
        <Button
          variant={tone === 'danger' ? 'destructive' : 'primary'}
          loading={busy}
          onClick={() => {
            if (!reason.trim()) {
              setError(errorLabel);
              return;
            }
            onConfirm(reason.trim());
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

/** Modal de "marcar como pagada": referencia + fecha + egreso del período. */
function PayDialog({
  busy,
  defaultDate,
  onConfirm,
  onClose,
}: {
  busy: boolean;
  defaultDate: string;
  onConfirm: (payload: { payment_reference: string; payment_date: string; create_expense: boolean }) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [createExpense, setCreateExpense] = useState(true);
  const [error, setError] = useState('');

  return (
    <Modal title={t('payOrders.payTitle')} onClose={busy ? () => {} : onClose}>
      <p className="text-sm text-muted-foreground">{t('payOrders.payDesc')}</p>

      <label className="block">
        <span className="block text-sm font-medium mb-1.5">
          {t('payOrders.payReference')}
          <span className="text-negative"> *</span>
        </span>
        <input
          autoFocus
          value={reference}
          onChange={(e) => {
            setReference(e.target.value);
            setError('');
          }}
          spellCheck={false}
          placeholder={t('payOrders.payReferencePlaceholder')}
          className={cn(INPUT, 'font-mono', error && 'border-negative')}
        />
        {error && <span className="block text-xs text-negative mt-1">{error}</span>}
      </label>

      <label className="block">
        <span className="block text-sm font-medium mb-1.5">{t('payOrders.payDate')}</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={INPUT} />
      </label>

      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={createExpense}
          onChange={(e) => setCreateExpense(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded border-border accent-[var(--color-primary)]"
        />
        <span>
          <span className="block text-sm font-medium">{t('payOrders.payCreateExpense')}</span>
          <span className="block text-xs text-muted-foreground">{t('payOrders.payCreateExpenseHint')}</span>
        </span>
      </label>

      <div className="flex justify-end gap-3 pt-2">
        <Button onClick={onClose} disabled={busy}>
          {t('payOrders.cancel')}
        </Button>
        <Button
          variant="primary"
          loading={busy}
          onClick={() => {
            if (!reference.trim()) {
              setError(t('payOrders.errReference'));
              return;
            }
            onConfirm({ payment_reference: reference.trim(), payment_date: date, create_expense: createExpense });
          }}
        >
          {t('payOrders.markPaid')}
        </Button>
      </div>
    </Modal>
  );
}

/** Shell de modal con campos — ConfirmDialog solo acepta un mensaje de texto. */
function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="bg-card rounded-xl shadow-[var(--elevation-3)] p-6 max-w-md w-full space-y-4 vex-pop-in max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold">{title}</h3>
        {children}
      </div>
    </div>
  );
}
