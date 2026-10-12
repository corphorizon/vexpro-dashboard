'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /ordenes-pago/[id] — detalle de una orden de pago.
//
// Dos cosas mandan en esta pantalla:
//   1. La máquina de estados (canTransition) decide qué botones EXISTEN.
//   2. Preparar ≠ decidir (`canDo`, roles.ts): quien prepara envía, retira a
//      borrador y anula su borrador; aprobar, rechazar y pagar exigen finanzas
//      — la MISMA regla que aplica el servidor en /transition.
//
// El historial no es decorativo: es la evidencia de tesorería (quién autorizó
// qué, cuándo y con qué referencia), por eso va completo y en orden
// (timeline.ts, con test).
//
// «Libro mayor» (2026-10-12, docs/diseno-libro-mayor.md):
//   · Cabecera: Nº en mono, badge (color de `statusKind`, registro único) y el
//     total grande con <Money> — el número que se viene a mirar.
//   · UN solo botón primario por estado (spec §5.1): la transición que hace
//     avanzar la orden (enviar → aprobar → pagar; en rechazada, volver a
//     borrador). Antes, en «pendiente», Aprobar era primario y Rechazar
//     destructivo relleno: dos rellenos de color compitiendo por el mismo clic.
//     Rechazar queda `danger` (tinte `neg`), Anular y Volver a borrador `ghost`.
//   · Línea de tiempo en un Panel: punto con el color del kind (rechazada y
//     anulada en `neg`), quién y cuándo, y en una orden viva los pasos que
//     faltan en gris.
//   · Líneas en FinTable con subtotal / comisiones / total en el pie (la
//     «doble raya» sólo en el total).
//   · Diálogos con Field / Input / Textarea: sin la receta de input copiada.
//
// Medición (colores fuera de tokens en este archivo): antes 1 paleta cruda
// (`bg-black/50`), 2 `var(--…)` en className, 40 tokens legados
// (`text-muted-foreground`, `bg-positive`, `text-negative`…) y 5 usos de la
// receta `INPUT`; después 0.
//
// DESCARTADO: mover las transiciones a un menú «···». Son la razón de ser de
// la pantalla para quien aprueba o paga; esconderlas detrás de un clic más
// esconde el control (que el creador VEA el botón es parte del control).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Ban,
  CheckCheck,
  Download,
  FileText,
  Paperclip,
  Pencil,
  RotateCcw,
  Send,
  Upload,
  Wallet,
  X,
} from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { Field, Input, Textarea } from '@/components/ui/field';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS, moneyText } from '@/components/ui/money';
import { STATUS_BADGE_CLASSES } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToasts } from '@/components/ui/toast';
import { StatusBadge } from '@/components/payment-orders/status-badge';
import { ActionButton, actionButtonClass, type ActionVariant } from '@/components/ui/action-button';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth-context';
import { paymentOrderTransitionNeedsFinance, roleCanPreparePaymentOrder, roleCanWriteFinance } from '@/lib/roles';
import { useData } from '@/lib/data-context';
import { cn } from '@/lib/utils';
import { formatDate, formatDateTime, todayUtcISO } from '@/lib/dates';
import {
  canTransition,
  isEditable,
  MAX_PAYMENT_ATTACHMENTS,
  MAX_PAYMENT_PROOFS,
  type PaymentOrder,
  type PaymentOrderAttachment,
  type PaymentOrderLine,
  type PaymentOrderProof,
  type PaymentOrderStatus,
} from '@/lib/payment-orders/types';
import {
  deleteOrderAttachment,
  deletePaymentProof,
  getPaymentOrder,
  orderAttachmentUrl,
  paymentProofUrl,
  transitionPaymentOrder,
  uploadOrderAttachments,
  uploadPaymentProofs,
  type TransitionOptions,
} from '@/lib/payment-orders/api';
import { PickedFileList, SavedFileList } from '@/components/payment-orders/order-files';
import { ATTACHMENT_ACCEPT, MAX_ATTACHMENT_SIZE } from '@/lib/payment-orders/attachment-files';
import { normCurrency } from '../orders-view';
import { buildTimeline, upcomingSteps, type TimelineEvent, type UpcomingStep } from './timeline';

type Dialog =
  | null
  | 'submit'
  | 'approve'
  | 'reject'
  | 'cancel'
  | 'pay'
  | 'reopen'
  | 'removeProof'
  | 'removeAttachment';

/** Mismo tope que el endpoint — validar acá evita subir 30 MB para nada. El
 *  tope de CANTIDAD sale de MAX_PAYMENT_PROOFS (types.ts), compartido con el
 *  servidor: la UI solo se adelanta, la autoridad sigue siendo el endpoint. */
const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const PROOF_ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp';
const MAX_PROOFS_STR = String(MAX_PAYMENT_PROOFS);

/** Documento de respaldo: mismo tope por archivo, pero admite además Office
 *  (docx/xlsx). El `accept` y el tope de bytes salen del módulo compartido para
 *  que la UI no pueda ofrecer un formato que el endpoint rechaza. */
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_SIZE;
const MAX_ATTACHMENTS_STR = String(MAX_PAYMENT_ATTACHMENTS);

/**
 * Qué transición es la PRIMARIA en cada estado: la primera de esta lista que
 * el usuario puede hacer. Es el «siguiente paso» del camino feliz; en
 * rechazada, volver a borrador. Una sola por pantalla (spec §5.1).
 */
const PRIMARY_PREFERENCE: readonly PaymentOrderStatus[] = ['pending', 'approved', 'paid', 'draft'];

type LineRow = PaymentOrderLine & { idx: number };

export default function OrdenPagoDetallePage() {
  const { t } = useI18n();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const router = useRouter();
  const { user } = useAuth();
  const { company, refreshSections } = useData();
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

  /** Moneda de los montos de ESTA orden (USDT se muestra como USD). */
  const currency = normCurrency(order?.currency, normCurrency(company?.currency));
  const money = useCallback((n: number) => moneyText(Number(n) || 0, { currency }), [currency]);

  // ── Permisos ──────────────────────────────────────────────────────────────
  // Aprobación abierta (decisión Kevin 2026-08-05): cualquier usuario con
  // acceso al módulo aprueba, incluida su propia orden. Se conserva el
  // registro: si el aprobador es el emisor, el historial lo muestra como
  // autoaprobada.
  const isCreator = Boolean(
    order?.created_by && (order.created_by === user?.id || order.created_by === user?.auth_user_id),
  );

  // El servidor solo acepta transiciones de FINANCE_ROLES (403 para el resto):
  // dibujarle Aprobar/Pagar a un socio o invitado es invitarlo a un error.
  const canAct = roleCanWriteFinance(user?.effective_role ?? '');
  // Preparar ≠ decidir (roles.ts, 2026-10-05). `canDo(to)` es la MISMA regla
  // que aplica el servidor en /transition: quien prepara puede enviar, retirar
  // a borrador y anular su borrador; aprobar/rechazar/pagar exige finanzas.
  const canPrepare = roleCanPreparePaymentOrder(user?.effective_role ?? '');
  const canDo = (from: string, to: string) =>
    paymentOrderTransitionNeedsFinance(from, to) ? canAct : canPrepare;

  /**
   * `proofFiles` solo llega desde el diálogo de pago (hasta MAX_PAYMENT_PROOFS).
   * Se suben DESPUÉS de la transición y en su propio try: los comprobantes son
   * opcionales, así que un fallo al subirlos no puede desandar ni bloquear el
   * "pagada" que ya se registró. Van en UN solo POST: el servidor acepta o
   * rechaza el lote entero, no deja la mitad arriba.
   */
  async function runTransition(
    to: PaymentOrderStatus,
    payload?: TransitionOptions,
    proofFiles?: File[],
  ) {
    if (!order) return;
    setBusy(true);
    try {
      const { order: updated, warning } = await transitionPaymentOrder(order.id, to, payload);
      const paid = updated ?? order;
      setOrder(paid);
      setDialog(null);
      // `warning` = la transición se aplicó pero algo secundario no (típico:
      // pagada sin período abierto donde registrar el egreso). No es un error.
      if (warning) toast.info(warning);
      else toast.success(t('payOrders.transitionOk'));
      // El egreso se crea SERVER-SIDE, así que el data-context (de donde lee
      // /egresos) no se entera solo: sin este refresh el egreso existe en la
      // DB pero no aparece en la pantalla de Egresos hasta recargar la app
      // — y con el snapshot de la fase 4b, ni siquiera al navegar.
      if (to === 'paid' && payload?.create_expense) {
        void refreshSections(['egresos']);
      }

      if (proofFiles && proofFiles.length > 0) {
        try {
          setOrder(await uploadPaymentProofs(paid.id, proofFiles));
          toast.success(
            proofFiles.length === 1
              ? t('payOrders.proofUploadOk')
              : t('payOrders.proofUploadOkMany', { count: String(proofFiles.length) }),
          );
        } catch (err) {
          // El lote es atómico server-side: si falla, no quedó ninguno arriba.
          // Se avisa con el mensaje del servidor (dice qué archivo lo rompió).
          toast.error(
            t(proofFiles.length === 1 ? 'payOrders.proofErrorAfterPay' : 'payOrders.proofSomeFailed', {
              error: err instanceof Error ? err.message : t('payOrders.proofError'),
            }),
          );
        }
      }

      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('payOrders.transitionError'));
    } finally {
      setBusy(false);
    }
  }

  // ── Comprobantes de pago (adjuntos opcionales, hasta MAX_PAYMENT_PROOFS) ──
  const proofInputRef = useRef<HTMLInputElement>(null);
  const [proofBusy, setProofBusy] = useState(false);
  /** Cuál se está por borrar: con varios, "borrá el comprobante" no alcanza. */
  const [proofToRemove, setProofToRemove] = useState<PaymentOrderProof | null>(null);

  const proofs = useMemo(() => order?.proofs ?? [], [order?.proofs]);
  const proofsFull = proofs.length >= MAX_PAYMENT_PROOFS;

  async function onProofsPicked(picked: File[]) {
    if (!order || picked.length === 0) return;
    // Dos chequeos que el servidor repite (él es la autoridad): acá solo evitan
    // un round-trip perdido con 40 MB de subida.
    if (proofs.length + picked.length > MAX_PAYMENT_PROOFS) {
      toast.error(t('payOrders.proofTooMany', { max: MAX_PROOFS_STR }));
      return;
    }
    if (picked.some((f) => f.size > MAX_PROOF_BYTES)) {
      toast.error(t('payOrders.proofTooLarge'));
      return;
    }
    setProofBusy(true);
    try {
      setOrder(await uploadPaymentProofs(order.id, picked));
      toast.success(
        picked.length === 1
          ? t('payOrders.proofUploadOk')
          : t('payOrders.proofUploadOkMany', { count: String(picked.length) }),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('payOrders.proofError'));
    } finally {
      setProofBusy(false);
    }
  }

  async function removeProof() {
    if (!order || !proofToRemove) return;
    setProofBusy(true);
    try {
      setOrder(await deletePaymentProof(order.id, proofToRemove.id));
      setDialog(null);
      setProofToRemove(null);
      toast.success(t('payOrders.proofRemoveOk'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('payOrders.proofError'));
    } finally {
      setProofBusy(false);
    }
  }

  // ── Documentos de respaldo (adjuntos opcionales, hasta MAX_PAYMENT_ATTACHMENTS) ──
  // OTROS adjuntos, no los comprobantes: acá va lo que JUSTIFICA la orden
  // (factura, contrato, cotización). Bucket y endpoint propios. Desde la
  // migración 127 son una LISTA, con las mismas reglas que los comprobantes.
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  /** Cuál se está por borrar: con varios, "borrá el respaldo" no alcanza. */
  const [attachToRemove, setAttachToRemove] = useState<PaymentOrderAttachment | null>(null);

  const attachments = useMemo(() => order?.attachments ?? [], [order?.attachments]);
  const attachmentsFull = attachments.length >= MAX_PAYMENT_ATTACHMENTS;

  async function onAttachmentsPicked(picked: File[]) {
    if (!order || picked.length === 0) return;
    // Dos chequeos que el servidor repite (él es la autoridad): acá solo evitan
    // un round-trip perdido con 100 MB de subida.
    if (attachments.length + picked.length > MAX_PAYMENT_ATTACHMENTS) {
      toast.error(t('payOrders.attachTooMany', { max: MAX_ATTACHMENTS_STR }));
      return;
    }
    if (picked.some((f) => f.size > MAX_ATTACHMENT_BYTES)) {
      toast.error(t('payOrders.attachTooLarge'));
      return;
    }
    setAttachBusy(true);
    try {
      // Uno por request: lo que entró QUEDA aunque uno falle, y el aviso dice
      // cuál falló y por qué (nunca un "no se pudo" genérico que se traga el
      // detalle).
      const { order: updated, failures } = await uploadOrderAttachments(order.id, picked);
      if (updated) setOrder(updated);
      const ok = picked.length - failures.length;
      if (ok > 0) {
        toast.success(
          ok === 1
            ? t('payOrders.attachUploadOk')
            : t('payOrders.attachUploadOkMany', { count: String(ok) }),
        );
      }
      if (failures.length > 0) {
        const detail = failures.map((f) => `${f.name}: ${f.error}`).join(' · ');
        toast.error(
          ok > 0
            ? t('payOrders.attachSomeFailed', { error: detail })
            : detail,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('payOrders.attachError'));
    } finally {
      setAttachBusy(false);
    }
  }

  async function removeAttachment() {
    if (!order || !attachToRemove) return;
    setAttachBusy(true);
    try {
      setOrder(await deleteOrderAttachment(order.id, attachToRemove.id));
      setDialog(null);
      setAttachToRemove(null);
      toast.success(t('payOrders.attachRemoveOk'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('payOrders.attachError'));
    } finally {
      setAttachBusy(false);
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

  const timeline = useMemo(() => (order ? buildTimeline(order) : []), [order]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-72" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Skeleton className="h-96 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="space-y-4">
        <BackLink label={t('payOrders.backToList')} />
        <Panel>
          <EmptyState
            icon={FileText}
            title={t('payOrders.notFoundTitle')}
            description={t('payOrders.notFoundDesc')}
            action={
              <Link href="/ordenes-pago" className={actionButtonClass('primary')}>
                {t('payOrders.backToList')}
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  const crypto = order.payment_method === 'crypto';
  const can = (to: PaymentOrderStatus) =>
    canDo(order.status, to) && canTransition(order.status, to) && to !== order.status;
  const primaryTo = PRIMARY_PREFERENCE.find(can) ?? null;
  const variantFor = (to: PaymentOrderStatus, fallback: ActionVariant): ActionVariant =>
    to === primaryTo ? 'primary' : fallback;
  const upcoming = upcomingSteps(order.status);

  // Dos líneas idénticas (mismo concepto e importe) son legítimas: la clave de
  // fila es la posición, no el contenido.
  const lineRows: LineRow[] = (order.lines ?? []).map((l, idx) => ({ ...l, idx }));
  const lineColumns: FinColumn<LineRow>[] = [
    {
      key: 'description',
      header: t('payOrders.lineDescription'),
      cell: (l) => <span className="whitespace-normal">{l.description || '—'}</span>,
    },
    {
      key: 'unitValue',
      header: t('payOrders.lineUnitValue'),
      kind: 'money',
      value: (l) => l.unitValue,
      subtotal: false,
      hideSm: true,
      money: { currency },
      cell: (l) => <Money value={l.unitValue} currency={currency} className="text-text-2" />,
    },
    {
      key: 'quantity',
      header: t('payOrders.lineQuantity'),
      kind: 'number',
      value: (l) => l.quantity,
      subtotal: false,
      hideSm: true,
      // La cantidad admite decimales (1.5 horas): no pasa por el formateador
      // de enteros de la columna `number`.
      cell: (l) => <span className={cn(NUM_CLASS, 'text-text-2')}>{l.quantity}</span>,
    },
    {
      key: 'amount',
      header: t('payOrders.lineAmount'),
      kind: 'money',
      value: (l) => l.amount,
      money: { currency },
    },
  ];

  return (
    <div className="space-y-4">
      {ToastHost}
      <BackLink label={t('payOrders.backToList')} />

      {/* ── Cabecera ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-mono text-[20px] font-[650] leading-7 tracking-[-0.015em] text-foreground sm:text-[22px]">
              {order.order_number}
            </h1>
            <StatusBadge status={order.status} />
          </div>
          <p className="mt-0.5 text-[13.5px] text-text-2">
            {t('payOrders.headerLine', {
              beneficiary: order.beneficiary_name || '—',
              date: formatDate(order.issue_date),
            })}
          </p>
          <Money
            value={order.total}
            currency={currency}
            nullLabel={t('ui.noData')}
            className="mt-2 block text-[24px] font-semibold leading-[30px] tracking-[-0.02em] text-foreground sm:text-[26px]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ActionButton onClick={downloadPdf} loading={pdfBusy}>
            <Download aria-hidden className="size-4" />
            {t('payOrders.downloadPdf')}
          </ActionButton>

          {canPrepare && isEditable(order.status) && (
            <Link href={`/ordenes-pago/${order.id}/editar`} className={actionButtonClass('secondary')}>
              <Pencil aria-hidden className="size-4" />
              {t('payOrders.edit')}
            </Link>
          )}

          {can('pending') && (
            <ActionButton variant={variantFor('pending', 'secondary')} onClick={() => setDialog('submit')}>
              <Send aria-hidden className="size-4" />
              {t('payOrders.submit')}
            </ActionButton>
          )}

          {can('approved') && (
            <ActionButton variant={variantFor('approved', 'secondary')} onClick={() => setDialog('approve')}>
              <CheckCheck aria-hidden className="size-4" />
              {t('payOrders.approve')}
            </ActionButton>
          )}

          {can('rejected') && (
            <ActionButton variant="danger" onClick={() => setDialog('reject')}>
              <X aria-hidden className="size-4" />
              {t('payOrders.reject')}
            </ActionButton>
          )}

          {can('paid') && (
            <ActionButton variant={variantFor('paid', 'secondary')} onClick={() => setDialog('pay')}>
              <Wallet aria-hidden className="size-4" />
              {t('payOrders.markPaid')}
            </ActionButton>
          )}

          {can('draft') && (
            <ActionButton variant={variantFor('draft', 'ghost')} onClick={() => setDialog('reopen')}>
              <RotateCcw aria-hidden className="size-4" />
              {t('payOrders.reopen')}
            </ActionButton>
          )}

          {can('cancelled') && (
            <ActionButton variant="ghost" onClick={() => setDialog('cancel')}>
              <Ban aria-hidden className="size-4" />
              {t('payOrders.void')}
            </ActionButton>
          )}
        </div>
      </div>

      {isCreator && order.status === 'pending' && (
        <p className="text-[12.5px] text-text-3">{t('payOrders.selfApproveNotice')}</p>
      )}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          {/* ── Detalle (líneas) ──────────────────────────────────────── */}
          <Panel
            title={t('payOrders.sectionLines')}
            hint={t('payOrders.linesHint', { n: String(order.lines?.length ?? 0) })}
            flush
          >
            <FinTable<LineRow>
              caption={t('payOrders.sectionLines')}
              columns={lineColumns}
              rows={lineRows}
              rowKey={(l) => String(l.idx)}
              empty={t('payOrders.noLines')}
              footerRows={[
                { label: t('payOrders.subtotal'), values: { amount: order.subtotal } },
                { label: t('payOrders.fees'), values: { amount: order.fees } },
              ]}
              footer={{ label: t('payOrders.total'), values: { amount: order.total } }}
            />
          </Panel>

          {/* ── Beneficiario + datos de la orden ──────────────────────── */}
          <div className="grid grid-cols-1 gap-4 min-[1100px]:grid-cols-2">
            <Panel title={t('payOrders.sectionBeneficiary')}>
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ReadField label={t('payOrders.benName')} value={order.beneficiary_name || '—'} strong />
                <ReadField label={t('payOrders.benTaxId')} value={order.beneficiary_tax_id || '—'} />
                <ReadField label={t('payOrders.benEmail')} value={order.beneficiary_email || '—'} breakAll />
                <ReadField label={t('payOrders.benCountry')} value={order.beneficiary_country || '—'} />
              </dl>
            </Panel>
            <Panel title={t('payOrders.sectionOrder')}>
              <dl className="grid grid-cols-2 gap-3">
                <ReadField label={t('payOrders.issueDate')} value={formatDate(order.issue_date)} num />
                <ReadField
                  label={t('payOrders.paymentDate')}
                  value={order.payment_date ? formatDate(order.payment_date) : '—'}
                  num
                />
                <ReadField label={t('payOrders.currency')} value={order.currency} />
                <ReadField label={t('payOrders.docLanguage')} value={order.locale === 'en' ? 'English' : 'Español'} />
              </dl>
            </Panel>
          </div>

          {/* ── Medio de pago ─────────────────────────────────────────── */}
          <Panel
            title={t('payOrders.sectionMethod')}
            hint={crypto ? t('payOrders.methodCryptoFull') : t('payOrders.methodBankFull')}
          >
            {crypto ? (
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ReadField label={t('payOrders.network')} value={order.crypto_network || '—'} />
                <ReadField label={t('payOrders.memo')} value={order.crypto_memo || '—'} mono />
                <div className="sm:col-span-2">
                  <ReadField label={t('payOrders.wallet')} value={order.crypto_wallet || '—'} mono breakAll />
                </div>
              </dl>
            ) : (
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ReadField label={t('payOrders.bankName')} value={order.bank_name || '—'} />
                <ReadField label={t('payOrders.accountHolder')} value={order.bank_account_holder || '—'} />
                <ReadField label={t('payOrders.accountNumber')} value={order.bank_account_number || '—'} mono breakAll />
                <ReadField label={t('payOrders.swift')} value={order.bank_swift || '—'} mono />
                <ReadField label={t('payOrders.accountType')} value={order.bank_account_type || '—'} />
              </dl>
            )}
          </Panel>

          {/* ── Concepto ──────────────────────────────────────────────── */}
          <Panel title={t('payOrders.sectionNotes')}>
            <p className="whitespace-pre-line text-[13px] text-text-2">{order.notes || '—'}</p>
          </Panel>

          {/* ── Documentos de respaldo (opcionales, hasta 10) ─────────── */}
          {/* Compañero del concepto: la factura / contrato / cotización que
              justifica el pago. Va acá y no al lado del comprobante para que
              los dos adjuntos no se confundan nunca. */}
          {(attachments.length > 0 || order.status !== 'cancelled') && (
            <Panel
              title={t('payOrders.attachSection')}
              hint={
                <span className={NUM_CLASS}>
                  {t('payOrders.fileCounter', { n: String(attachments.length), max: MAX_ATTACHMENTS_STR })}
                </span>
              }
              actions={
                order.status !== 'cancelled' ? (
                  <ActionButton
                    aria-label={t('payOrders.attachAddAria')}
                    loading={attachBusy}
                    disabled={attachmentsFull}
                    onClick={() => attachInputRef.current?.click()}
                  >
                    <FileText aria-hidden className="size-4" />
                    {attachments.length === 0 ? t('payOrders.attachAttach') : t('payOrders.attachAdd')}
                  </ActionButton>
                ) : undefined
              }
              footer={
                order.status !== 'cancelled'
                  ? attachmentsFull
                    ? t('payOrders.attachMaxReached', { max: MAX_ATTACHMENTS_STR })
                    : t('payOrders.attachHintMulti', { max: MAX_ATTACHMENTS_STR })
                  : undefined
              }
            >
              {/* `multiple`: se pueden elegir varios de una. El input se limpia
                  siempre para poder volver a elegir el mismo archivo. */}
              <input
                ref={attachInputRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  void onAttachmentsPicked(picked);
                }}
              />

              {attachments.length > 0 ? (
                <SavedFileList
                  files={attachments}
                  texts={{
                    fallbackName: t('payOrders.attachSection'),
                    uploadedAt: (date) => t('payOrders.attachUploaded', { date: formatDateTime(date) }),
                    view: t('payOrders.attachView'),
                    viewAria: (name) => t('payOrders.attachViewItemAria', { name }),
                    download: t('payOrders.attachDownload'),
                    downloadAria: (name) => t('payOrders.attachDownloadAria', { name }),
                    remove: t('payOrders.attachRemove'),
                    removeAria: (name) => t('payOrders.attachRemoveItemAria', { name }),
                  }}
                  hrefFor={(f) => orderAttachmentUrl(order.id, f.id)}
                  downloadHrefFor={(f) => orderAttachmentUrl(order.id, f.id, { download: true })}
                  disabled={attachBusy}
                  // Una orden anulada es un documento cerrado: se puede ver el
                  // respaldo, pero no cambiarlo.
                  onRemove={
                    order.status === 'cancelled'
                      ? null
                      : (f) => {
                          setAttachToRemove(f as PaymentOrderAttachment);
                          setDialog('removeAttachment');
                        }
                  }
                />
              ) : (
                <p className="text-[13px] text-text-3">{t('payOrders.attachNone')}</p>
              )}
            </Panel>
          )}

          {/* ── Comprobantes de pago (opcionales, hasta 10) ───────────── */}
          {/* Metadato operativo: se pueden agregar o quitar aun con la orden
              pagada. Solo desaparece en una orden anulada. */}
          {order.status !== 'cancelled' && (proofs.length > 0 || order.status === 'paid') && (
            <Panel
              title={
                <span className="inline-flex items-center gap-1.5">
                  <Paperclip aria-hidden className="size-4 text-text-3" />
                  {t('payOrders.proofSection')}
                </span>
              }
              hint={
                <span className={NUM_CLASS}>
                  {t('payOrders.fileCounter', { n: String(proofs.length), max: MAX_PROOFS_STR })}
                </span>
              }
              actions={
                <ActionButton
                  aria-label={t('payOrders.proofAddAria')}
                  loading={proofBusy}
                  disabled={proofsFull}
                  onClick={() => proofInputRef.current?.click()}
                >
                  <Upload aria-hidden className="size-4" />
                  {proofs.length === 0 ? t('payOrders.proofAttach') : t('payOrders.proofAdd')}
                </ActionButton>
              }
              footer={
                proofsFull
                  ? t('payOrders.proofMaxReached', { max: MAX_PROOFS_STR })
                  : t('payOrders.proofHintMulti', { max: MAX_PROOFS_STR })
              }
            >
              {/* `multiple`: se pueden elegir varios de una. El input se limpia
                  siempre para poder volver a elegir el mismo archivo. */}
              <input
                ref={proofInputRef}
                type="file"
                multiple
                accept={PROOF_ACCEPT}
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  const picked = Array.from(e.target.files ?? []);
                  e.target.value = '';
                  void onProofsPicked(picked);
                }}
              />

              {proofs.length > 0 ? (
                <SavedFileList
                  files={proofs}
                  texts={{
                    fallbackName: t('payOrders.proofSection'),
                    uploadedAt: (date) => t('payOrders.proofUploaded', { date: formatDateTime(date) }),
                    view: t('payOrders.proofView'),
                    viewAria: (name) => t('payOrders.proofViewItemAria', { name }),
                    download: t('payOrders.proofDownload'),
                    downloadAria: (name) => t('payOrders.proofDownloadAria', { name }),
                    remove: t('payOrders.proofRemove'),
                    removeAria: (name) => t('payOrders.proofRemoveItemAria', { name }),
                  }}
                  hrefFor={(f) => paymentProofUrl(order.id, f.id)}
                  downloadHrefFor={(f) => paymentProofUrl(order.id, f.id, { download: true })}
                  disabled={proofBusy}
                  onRemove={(f) => {
                    setProofToRemove(f as PaymentOrderProof);
                    setDialog('removeProof');
                  }}
                />
              ) : (
                <p className="text-[13px] text-text-3">{t('payOrders.proofNone')}</p>
              )}
            </Panel>
          )}
        </div>

        {/* ── Línea de tiempo ─────────────────────────────────────────── */}
        <Panel title={t('payOrders.timeline')} hint={t('payOrders.tlHint')} className="lg:sticky lg:top-4">
          <Timeline events={timeline} upcoming={upcoming} />
        </Panel>
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
          busy={busy}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => runTransition('cancelled', { reason })}
        />
      )}

      {dialog === 'pay' && (
        <PayDialog
          busy={busy}
          defaultDate={order.payment_date || todayUtcISO()}
          onClose={() => setDialog(null)}
          onConfirm={(payload, proofFiles) => runTransition('paid', payload, proofFiles)}
        />
      )}

      {dialog === 'removeProof' && proofToRemove && (
        <ConfirmDialog
          title={t('payOrders.proofRemoveTitle')}
          message={t('payOrders.proofRemoveMessage')}
          confirmLabel={t('payOrders.proofRemove')}
          onConfirm={removeProof}
          onClose={() => {
            setDialog(null);
            setProofToRemove(null);
          }}
        />
      )}

      {dialog === 'removeAttachment' && attachToRemove && (
        <ConfirmDialog
          title={t('payOrders.attachRemoveTitle')}
          message={t('payOrders.attachRemoveMessage')}
          confirmLabel={t('payOrders.attachRemove')}
          onConfirm={removeAttachment}
          onClose={() => {
            setDialog(null);
            setAttachToRemove(null);
          }}
        />
      )}
    </div>
  );
}

// ── Línea de tiempo ─────────────────────────────────────────────────────────

/** ¿La referencia es un link? Kevin a veces pega el hash y a veces la URL del
 *  explorer; cuando es URL conviene que se pueda abrir de un clic. Solo
 *  http/https — nada de javascript: ni data:. */
function isUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const EVENT_TITLE_KEY: Record<TimelineEvent['kind'], string> = {
  created: 'payOrders.tlCreated',
  submitted: 'payOrders.tlSubmitted',
  approved: 'payOrders.tlApproved',
  rejected: 'payOrders.tlRejected',
  paid: 'payOrders.tlPaid',
  cancelled: 'payOrders.tlCancelled',
  expense: 'payOrders.tlExpense',
};

const NEXT_KEY: Record<UpcomingStep, string> = {
  submitted: 'payOrders.tlNextSubmitted',
  approved: 'payOrders.tlNextApproved',
  paid: 'payOrders.tlNextPaid',
};

function Timeline({ events, upcoming }: { events: TimelineEvent[]; upcoming: UpcomingStep[] }) {
  const { t } = useI18n();
  const total = events.length + upcoming.length;
  return (
    <ol className="space-y-0">
      {events.map((ev, i) => (
        <li key={`${ev.kind}-${i}`} className="relative pb-4 pl-7 last:pb-0" data-kind={ev.kind} data-tone={ev.tone}>
          {/* Punto con halo: el par texto/fondo del badge del mismo kind
              (STATUS_BADGE_CLASSES) — sin una segunda tabla de colores. */}
          <span
            aria-hidden
            className={cn(
              'absolute left-0 top-0.5 inline-flex size-4 items-center justify-center rounded-full',
              STATUS_BADGE_CLASSES[ev.tone],
            )}
          >
            <span className="size-1.5 rounded-full bg-current" />
          </span>
          {i < total - 1 && <span aria-hidden className="absolute bottom-0 left-[7.5px] top-5 w-px bg-border" />}
          <p className={cn('text-[13px] font-medium leading-5', ev.tone === 'bad' ? 'text-neg' : 'text-foreground')}>
            {/* «Enviada» y «egreso» no tienen {who}: el reemplazo no hace nada. */}
            {t(EVENT_TITLE_KEY[ev.kind], { who: ev.actor ?? t('payOrders.unknownUser') })}
          </p>
          {ev.at && <p className={cn(NUM_CLASS, 'text-[12px] text-text-3')}>{formatDateTime(ev.at)}</p>}
          {ev.selfApproved && <p className="mt-0.5 text-[12px] text-text-3">{t('payOrders.tlSelfApproved')}</p>}
          {ev.reason && (
            <p className="mt-1 break-words text-[12px] text-text-2">{t('payOrders.tlReason', { reason: ev.reason })}</p>
          )}
          {ev.reference && (
            <p className="mt-1 min-w-0 text-[12px] text-text-2">
              <span className="block text-text-3">{t('payOrders.tlReferenceLabel')}</span>
              {/* break-all: un hash o una URL de explorer no tienen espacios,
                  así que sin esto desbordan el panel. */}
              {isUrl(ev.reference) ? (
                <a
                  href={ev.reference}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-info hover:underline"
                >
                  {ev.reference}
                </a>
              ) : (
                <span className="break-all font-mono">{ev.reference}</span>
              )}
            </p>
          )}
        </li>
      ))}
      {upcoming.map((step, j) => (
        <li key={`next-${step}`} className="relative pb-4 pl-7 last:pb-0" data-kind={`next-${step}`}>
          <span
            aria-hidden
            className="absolute left-[3px] top-[5px] size-2.5 rounded-full border border-dashed border-border-strong bg-card"
          />
          {events.length + j < total - 1 && (
            <span aria-hidden className="absolute bottom-0 left-[7.5px] top-5 w-px border-l border-dashed border-border" />
          )}
          <p className="text-[13px] leading-5 text-text-3">
            <span className="sr-only">{t('payOrders.tlNextTitle')}: </span>
            {t(NEXT_KEY[step])}
          </p>
        </li>
      ))}
    </ol>
  );
}

// ── Piezas de presentación ──────────────────────────────────────────────────

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href="/ordenes-pago"
      className="inline-flex items-center gap-1.5 text-[13px] text-text-2 hover:text-foreground"
    >
      <ArrowLeft aria-hidden className="size-4" />
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
  num,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
  breakAll?: boolean;
  num?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium text-text-3">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 text-[13px] text-foreground',
          mono && 'font-mono text-[12px]',
          strong && 'font-semibold',
          breakAll && 'break-all',
          num && NUM_CLASS,
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** Modal chico para transiciones que exigen un motivo escrito (rechazar, anular). */
function ReasonDialog({
  title,
  description,
  label,
  confirmLabel,
  errorLabel,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  label: string;
  confirmLabel: string;
  errorLabel: string;
  busy: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  return (
    <Modal title={title} onClose={busy ? () => {} : onClose}>
      <p className="text-[13px] text-text-2">{description}</p>
      <Field label={label} required error={error || undefined}>
        <Textarea
          autoFocus
          rows={3}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError('');
          }}
          className="resize-y"
        />
      </Field>
      <div className="flex justify-end gap-2 pt-2">
        <ActionButton onClick={onClose} disabled={busy}>
          {t('payOrders.cancel')}
        </ActionButton>
        <ActionButton
          variant="danger"
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
        </ActionButton>
      </div>
    </Modal>
  );
}

/** Modal de "marcar como pagada": referencia + fecha + comprobantes + egreso del período. */
function PayDialog({
  busy,
  defaultDate,
  onConfirm,
  onClose,
}: {
  busy: boolean;
  defaultDate: string;
  onConfirm: (
    payload: {
      payment_reference: string;
      payment_date: string;
      create_expense: boolean;
      expense_category?: string | null;
    },
    proofFiles: File[],
  ) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { allExpenses } = useData();
  const proofInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [createExpense, setCreateExpense] = useState(true);
  const [expenseCategory, setExpenseCategory] = useState('');
  // Categorías ya usadas por la empresa — se ofrecen como sugerencia para no
  // fragmentar el catálogo con variantes tipeadas a mano ("SaaS"/"saas"/…).
  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of allExpenses) {
      const c = (e.category ?? '').trim();
      if (c) set.add(c);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [allExpenses]);
  // Selección acumulativa: cada pasada por el input SUMA a lo ya elegido (así
  // se pueden juntar archivos de carpetas distintas sin perder los anteriores).
  const [proofFiles, setProofFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [fileError, setFileError] = useState('');
  const proofsLeft = MAX_PAYMENT_PROOFS - proofFiles.length;

  return (
    <Modal title={t('payOrders.payTitle')} onClose={busy ? () => {} : onClose}>
      <p className="text-[13px] text-text-2">{t('payOrders.payDesc')}</p>

      <Field label={t('payOrders.payReference')} required error={error || undefined}>
        <Input
          autoFocus
          value={reference}
          onChange={(e) => {
            setReference(e.target.value);
            setError('');
          }}
          spellCheck={false}
          placeholder={t('payOrders.payReferencePlaceholder')}
          className="font-mono"
        />
      </Field>

      <Field label={t('payOrders.payDate')}>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>

      {/* Comprobantes: OPCIONALES, hasta MAX_PAYMENT_PROOFS. Se suben después
          de registrar el pago, así que si falla la subida el pago igual queda
          asentado. */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] font-medium text-text-2">{t('payOrders.proofField')}</span>
          <span className={cn(NUM_CLASS, 'text-[12px] text-text-3')}>
            {t('payOrders.fileCounter', { n: String(proofFiles.length), max: MAX_PROOFS_STR })}
          </span>
        </div>
        <input
          ref={proofInputRef}
          type="file"
          multiple
          accept={PROOF_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = ''; // permite volver a elegir el mismo archivo
            if (picked.length === 0) return;
            if (picked.some((f) => f.size > MAX_PROOF_BYTES)) {
              setFileError(t('payOrders.proofTooLarge'));
              return;
            }
            if (picked.length > proofsLeft) {
              setFileError(t('payOrders.proofTooMany', { max: MAX_PROOFS_STR }));
              return;
            }
            setFileError('');
            setProofFiles((prev) => [...prev, ...picked]);
          }}
        />
        <ActionButton disabled={proofsLeft <= 0} onClick={() => proofInputRef.current?.click()}>
          <Upload aria-hidden className="size-4" />
          {proofFiles.length === 0 ? t('payOrders.proofAttach') : t('payOrders.proofAdd')}
        </ActionButton>
        <PickedFileList
          files={proofFiles}
          onRemove={(i) => setProofFiles((prev) => prev.filter((_, j) => j !== i))}
          removeAria={(name) => t('payOrders.proofUnselectAria', { name })}
        />
        {fileError ? (
          <p role="alert" className="text-[12px] text-neg">
            {fileError}
          </p>
        ) : (
          <p className="text-[12px] text-text-3">
            {proofsLeft <= 0
              ? t('payOrders.proofMaxReached', { max: MAX_PROOFS_STR })
              : t('payOrders.proofHintMulti', { max: MAX_PROOFS_STR })}
          </p>
        )}
      </div>

      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={createExpense}
          onChange={(e) => setCreateExpense(e.target.checked)}
          className="mt-0.5 size-4 rounded-ui-sm border-control-border accent-primary"
        />
        <span>
          <span className="block text-[13px] font-medium text-foreground">{t('payOrders.payCreateExpense')}</span>
          <span className="block text-[12px] text-text-3">{t('payOrders.payCreateExpenseHint')}</span>
        </span>
      </label>

      {/* La categoría solo tiene sentido si el egreso se va a crear. */}
      {createExpense && (
        <Field label={t('payOrders.payExpenseCategory')} hint={t('payOrders.payExpenseCategoryHint')}>
          <Input
            list="payorder-expense-categories"
            value={expenseCategory}
            onChange={(e) => setExpenseCategory(e.target.value)}
            placeholder={t('payOrders.payExpenseCategoryPlaceholder')}
          />
        </Field>
      )}
      <datalist id="payorder-expense-categories">
        {categoryOptions.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

      <div className="flex justify-end gap-2 pt-2">
        <ActionButton onClick={onClose} disabled={busy}>
          {t('payOrders.cancel')}
        </ActionButton>
        <ActionButton
          variant="primary"
          loading={busy}
          onClick={() => {
            if (!reference.trim()) {
              setError(t('payOrders.errReference'));
              return;
            }
            onConfirm(
              {
                payment_reference: reference.trim(),
                payment_date: date,
                create_expense: createExpense,
                expense_category: createExpense ? expenseCategory.trim() || null : null,
              },
              proofFiles,
            );
          }}
        >
          {t('payOrders.markPaid')}
        </ActionButton>
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
    // Scrim de la spec (§6.1): negro al 45 %, el mismo en los dos temas.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.45)] p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="vex-pop-in max-h-[90vh] w-full max-w-md space-y-4 overflow-y-auto rounded-ui-xl border border-border bg-card p-5 shadow-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[15px] font-semibold tracking-[-0.005em] text-foreground">{title}</h3>
        {children}
      </div>
    </div>
  );
}
