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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Paperclip,
  Pencil,
  Send,
  Upload,
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
import { roleCanWriteFinance } from '@/lib/roles';
import { useData } from '@/lib/data-context';
import { cn, formatCurrency } from '@/lib/utils';
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
import {
  PickedFileList,
  SavedFileList,
} from '@/components/payment-orders/order-files';
import { ATTACHMENT_ACCEPT, MAX_ATTACHMENT_SIZE } from '@/lib/payment-orders/attachment-files';

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


const INPUT =
  'w-full px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm placeholder:text-muted-foreground';

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

  const money = useCallback(
    (n: number) =>
      formatCurrency(n ?? 0, order?.currency === 'USDT' ? 'USD' : order?.currency || company?.currency || 'USD'),
    [order?.currency, company?.currency],
  );

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

          {canAct && isEditable(order.status) && (
            <Link href={`/ordenes-pago/${order.id}/editar`}>
              <Button variant="secondary">
                <Pencil className="w-4 h-4" />
                {t('payOrders.edit')}
              </Button>
            </Link>
          )}

          {canAct && canTransition(order.status, 'pending') && (
            <Button variant="primary" onClick={() => setDialog('submit')}>
              <Send className="w-4 h-4" />
              {t('payOrders.submit')}
            </Button>
          )}

          {canAct && canTransition(order.status, 'approved') && (
            <Button variant="primary" onClick={() => setDialog('approve')}>
              <CheckCheck className="w-4 h-4" />
              {t('payOrders.approve')}
            </Button>
          )}

          {canAct && canTransition(order.status, 'rejected') && (
            <Button variant="destructive" onClick={() => setDialog('reject')}>
              <X className="w-4 h-4" />
              {t('payOrders.reject')}
            </Button>
          )}

          {canAct && canTransition(order.status, 'paid') && (
            <Button variant="primary" onClick={() => setDialog('pay')}>
              <Wallet className="w-4 h-4" />
              {t('payOrders.markPaid')}
            </Button>
          )}

          {canAct && canTransition(order.status, 'draft') && order.status !== 'draft' && (
            <Button variant="ghost" onClick={() => setDialog('reopen')}>
              {t('payOrders.reopen')}
            </Button>
          )}

          {canAct && canTransition(order.status, 'cancelled') && (
            <Button variant="ghost" onClick={() => setDialog('cancel')}>
              <Ban className="w-4 h-4" />
              {t('payOrders.void')}
            </Button>
          )}
        </div>
      </div>

      {isCreator && order.status === 'pending' && (
        <p className="text-xs text-muted-foreground">{t('payOrders.selfApproveNotice')}</p>
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

          {/* ── Comprobantes de pago (opcionales, hasta 5) ────────────── */}
          {/* Metadato operativo: se pueden agregar o quitar aun con la orden
              pagada. Solo desaparece en una orden anulada. */}
          {order.status !== 'cancelled' && (proofs.length > 0 || order.status === 'paid') && (
            <Card className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <Paperclip className="w-4 h-4 text-muted-foreground" />
                  {t('payOrders.proofSection')}
                </h2>
                {proofs.length > 0 && (
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                    {t('payOrders.proofCount', { n: String(proofs.length), max: MAX_PROOFS_STR })}
                  </span>
                )}
              </div>

              {/* `multiple`: se pueden elegir varios de una. El input se limpia
                  siempre para poder volver a elegir el mismo archivo. */}
              <input
                ref={proofInputRef}
                type="file"
                multiple
                accept={PROOF_ACCEPT}
                className="sr-only"
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
                    uploadedAt: (date) =>
                      t('payOrders.proofUploaded', { date: formatDateTime(date) }),
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
                <p className="text-sm text-muted-foreground">{t('payOrders.proofNone')}</p>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                <Button
                  aria-label={t('payOrders.proofAddAria')}
                  loading={proofBusy}
                  disabled={proofsFull}
                  onClick={() => proofInputRef.current?.click()}
                >
                  <Upload className="w-4 h-4" />
                  {proofs.length === 0 ? t('payOrders.proofAttach') : t('payOrders.proofAdd')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {proofsFull
                    ? t('payOrders.proofMaxReached', { max: MAX_PROOFS_STR })
                    : t('payOrders.proofHintMulti', { max: MAX_PROOFS_STR })}
                </span>
              </div>
            </Card>
          )}

          {/* ── Concepto ──────────────────────────────────────────────── */}
          <Card className="space-y-3">
            <h2 className="text-base font-semibold">{t('payOrders.sectionNotes')}</h2>
            <p className="text-sm whitespace-pre-line text-muted-foreground">{order.notes || '—'}</p>
          </Card>

          {/* ── Documento de respaldo (opcional) ──────────────────────── */}
          {/* Compañero del concepto: la factura / contrato / cotización que
              justifica el pago. Va acá y no al lado del comprobante para que
              los dos adjuntos no se confundan nunca. */}
          {(attachments.length > 0 || order.status !== 'cancelled') && (
            <Card className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold flex items-center gap-2">
                  <FileText className="w-4 h-4 text-muted-foreground" />
                  {t('payOrders.attachSection')}
                </h2>
                {attachments.length > 0 && (
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                    {t('payOrders.attachCount', {
                      n: String(attachments.length),
                      max: MAX_ATTACHMENTS_STR,
                    })}
                  </span>
                )}
              </div>

              {/* `multiple`: se pueden elegir varios de una. El input se limpia
                  siempre para poder volver a elegir el mismo archivo. */}
              <input
                ref={attachInputRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                className="sr-only"
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
                    uploadedAt: (date) =>
                      t('payOrders.attachUploaded', { date: formatDateTime(date) }),
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
                <p className="text-sm text-muted-foreground">{t('payOrders.attachNone')}</p>
              )}

              {order.status !== 'cancelled' && (
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                  <Button
                    variant="secondary"
                    aria-label={t('payOrders.attachAddAria')}
                    loading={attachBusy}
                    disabled={attachmentsFull}
                    onClick={() => attachInputRef.current?.click()}
                  >
                    <FileText className="w-4 h-4" />
                    {attachments.length === 0
                      ? t('payOrders.attachAttach')
                      : t('payOrders.attachAdd')}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {attachmentsFull
                      ? t('payOrders.attachMaxReached', { max: MAX_ATTACHMENTS_STR })
                      : t('payOrders.attachHintMulti', { max: MAX_ATTACHMENTS_STR })}
                  </span>
                </div>
              )}
            </Card>
          )}
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
                {ev.detail && (
                  <p className="text-xs text-muted-foreground mt-1 break-words">{ev.detail}</p>
                )}
                {ev.reference && (
                  <p className="text-xs text-muted-foreground mt-1 min-w-0">
                    <span className="block">{t('payOrders.tlReferenceLabel')}</span>
                    {/* break-all: un hash o una URL de explorer no tienen
                        espacios, así que sin esto desbordan la tarjeta. */}
                    {isUrl(ev.reference) ? (
                      <a
                        href={ev.reference}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-info hover:underline break-all"
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

// ── Historial ───────────────────────────────────────────────────────────────

interface TimelineEvent {
  title: string;
  when?: string;
  detail?: string;
  /** Referencia de pago: se renderiza aparte porque puede ser una URL
   *  (link clickeable) y suele ser larga (necesita corte de palabra). */
  reference?: string;
  tone: 'positive' | 'negative' | 'warning' | 'neutral';
}

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
      reference: o.payment_reference || undefined,
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

      {/* Comprobantes: OPCIONALES, hasta MAX_PAYMENT_PROOFS. Se suben después
          de registrar el pago, así que si falla la subida el pago igual queda
          asentado. */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="block text-sm font-medium">{t('payOrders.proofField')}</span>
          {proofFiles.length > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {t('payOrders.proofCount', {
                n: String(proofFiles.length),
                max: String(MAX_PAYMENT_PROOFS),
              })}
            </span>
          )}
        </div>
        <input
          type="file"
          multiple
          accept={PROOF_ACCEPT}
          disabled={proofsLeft <= 0}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = ''; // permite volver a elegir el mismo archivo
            if (picked.length === 0) return;
            if (picked.some((f) => f.size > MAX_PROOF_BYTES)) {
              setFileError(t('payOrders.proofTooLarge'));
              return;
            }
            if (picked.length > proofsLeft) {
              setFileError(t('payOrders.proofTooMany', { max: String(MAX_PAYMENT_PROOFS) }));
              return;
            }
            setFileError('');
            setProofFiles((prev) => [...prev, ...picked]);
          }}
          className={cn(
            INPUT,
            'file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1 file:text-sm file:text-foreground',
            fileError && 'border-negative',
          )}
        />
        <PickedFileList
          files={proofFiles}
          onRemove={(i) => setProofFiles((prev) => prev.filter((_, j) => j !== i))}
          removeAria={(name) => t('payOrders.proofUnselectAria', { name })}
        />
        {fileError ? (
          <span className="block text-xs text-negative">{fileError}</span>
        ) : (
          <span className="block text-xs text-muted-foreground">
            {proofsLeft <= 0
              ? t('payOrders.proofMaxReached', { max: String(MAX_PAYMENT_PROOFS) })
              : t('payOrders.proofHintMulti', { max: String(MAX_PAYMENT_PROOFS) })}
          </span>
        )}
      </div>

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

      {/* La categoría solo tiene sentido si el egreso se va a crear. */}
      {createExpense && (
        <label className="block">
          <span className="block text-sm font-medium mb-1.5">{t('payOrders.payExpenseCategory')}</span>
          <input
            list="payorder-expense-categories"
            value={expenseCategory}
            onChange={(e) => setExpenseCategory(e.target.value)}
            placeholder={t('payOrders.payExpenseCategoryPlaceholder')}
            className={INPUT}
          />
          <datalist id="payorder-expense-categories">
            {categoryOptions.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <span className="block text-xs text-muted-foreground mt-1">
            {t('payOrders.payExpenseCategoryHint')}
          </span>
        </label>
      )}

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
