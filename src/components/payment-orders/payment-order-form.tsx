'use client';

// ─────────────────────────────────────────────────────────────────────────────
// PaymentOrderForm — formulario compartido de alta y edición de órdenes de pago.
//
// Una sola implementación para /ordenes-pago/nueva y /ordenes-pago/[id]/editar:
// la orden solo se edita en draft/rejected (isEditable), así que el modo de
// edición no cambia el layout, solo el destino del guardado y las etiquetas de
// los botones.
//
// Reglas que este formulario respeta a rajatabla:
//   · Los montos NUNCA se calculan a mano acá: subtotal/total salen de
//     computeTotals() y cada línea de computeLineAmount(), las mismas funciones
//     que corre el servidor. Lo que se ve en el preview es exactamente lo que
//     se va a guardar.
//   · Los importes viven en state como STRING mientras se tipean (para no
//     pelear con el cursor ni con el "0" pegado adelante) y se convierten a
//     number recién al calcular y al enviar.
//   · La validación de cliente espeja la del endpoint — es UX, no seguridad.
//
// «Libro mayor» (2026-10-12, docs/diseno-libro-mayor.md §5.6):
//   · Todos los campos son Field / Input / Select / Textarea de ui/field.tsx.
//     Antes había una receta local `INPUT` (borde `border-border`, 1,2:1
//     contra blanco: el control casi no se ve) copiada en 22 lugares de este
//     archivo, más `INPUT_ERR`, un `Field` y un `Segmented` locales. Ahora el
//     borde es `control-border` (3:1), el error lleva ícono + texto +
//     `aria-invalid`, y el foco es el global — ninguna receta propia.
//   · Líneas: grilla alineada con los tokens de FinTable (cabecera 11.5
//     MAYÚSCULAS, montos a la derecha con <Money>, total con la doble raya).
//   · Avisos (moneda que no es la de la empresa, wallet) con <Notice>; los
//     textos de moneda pasaron de un `CURRENCY_COPY` local a i18n.
//   · Adjuntos: contador «n / 10» en `text-3` en la cabecera del panel.
//
// Medición: antes 33 tokens legados, 3 `var(--…)` en className y 22 usos de
// `INPUT`; después 0.
//
// DESCARTADO: FinTable editable para las líneas — FinTable dibuja valores
// (<Money>, metadatos, tarjeta móvil); meterle controles adentro obligaría a
// otra API. La grilla usa los mismos tokens y alinea igual.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, BookUser, FileText, Landmark, Plus, Trash2, Wallet } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { Notice } from '@/components/ui/notice';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { useToasts } from '@/components/ui/toast';
import { ActionButton, ROW_ACTION_CLASS } from '@/components/payment-orders/action-button';
import { useI18n } from '@/lib/i18n';
import { useData } from '@/lib/data-context';
import { cn } from '@/lib/utils';
import { todayUtcISO } from '@/lib/dates';
import {
  CRYPTO_NETWORKS,
  LEGACY_ATTACHMENT_ID,
  MAX_PAYMENT_ATTACHMENTS,
  computeLineAmount,
  computeTotals,
  type PaymentBeneficiary,
  type PaymentMethod,
  type PaymentOrder,
  type PaymentOrderAttachment,
  type PaymentOrderInput,
  type PaymentOrderLocale,
} from '@/lib/payment-orders/types';
import { PickedFileList, SavedFileList } from '@/components/payment-orders/order-files';
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_SIZE,
} from '@/lib/payment-orders/attachment-files';
// NOTA: estas helpers las escribe el módulo hermano (src/lib/payment-orders/api.ts).
// Firmas asumidas: createPaymentOrder(input), updatePaymentOrder(id, input),
// transitionPaymentOrder(id, to, payload?), listBeneficiaries().
import {
  createPaymentOrder,
  updatePaymentOrder,
  transitionPaymentOrder,
  listBeneficiaries,
  listLineSuggestions,
  type LineSuggestion,
  uploadOrderAttachments,
  deleteOrderAttachment,
  orderAttachmentUrl,
} from '@/lib/payment-orders/api';

/** Columnas de la grilla de líneas: concepto | unitario | cantidad | monto | quitar.
 *  En móvil (< 640) dos columnas: el concepto ocupa la fila entera. */
const LINE_GRID =
  'grid grid-cols-2 items-center gap-x-3 px-4 sm:grid-cols-[minmax(0,1fr)_120px_88px_128px_32px]';

const OTHER_NETWORK = '__other__';

// ── Moneda: la de la empresa, y nada más ─────────────────────────────────────
// El selector ofrecía USD/USDT/EUR/GBP/ARS/MXN/BRL, pero cuando la orden se
// marca PAGADA el egreso se inserta con `total` TAL CUAL (payment-orders/
// server.ts) y la tabla `expenses` no tiene columna de moneda: una OP de
// 500.000 ARS entraba a la contabilidad como 500.000 "dólares" y se llevaba
// puesto el período, la cadena de distribución y todo lo que cuelga de ella.
//
// Mientras no exista moneda + tipo de cambio en `expenses`, la única lectura
// correcta es que una OP se emite en la moneda de la empresa (companies.
// currency, la misma que usa formatCurrency en todo el dashboard).
//
// USDT se admite cuando la empresa opera en USD: no es otra moneda para esta
// contabilidad —el resto de la app ya lo trata 1:1 con el dólar (el listado y
// el detalle de órdenes hacen `currency === 'USDT' ? 'USD'`)— y es el medio
// real de los pagos crypto, que son el camino por defecto del formulario.
function allowedCurrencies(companyCurrency: string | null | undefined): string[] {
  const base = (companyCurrency || 'USD').toUpperCase();
  return base === 'USD' ? ['USD', 'USDT'] : [base];
}

/** Documentos de respaldo — mismos límites que el endpoint, importados de él
 *  (validar acá evita subir 100 MB para nada; la autoridad sigue siendo el
 *  servidor). El tope de CANTIDAD es MAX_PAYMENT_ATTACHMENTS. */
const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_SIZE;


// La fecha por defecto es el día UTC, no el local del navegador: la
// OP-2026-0042 nació fechada mañana porque quien la creó estaba en un huso
// adelantado. Ver `todayUtcISO` en lib/dates.ts.

const num = (v: string) => {
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

interface LineDraft {
  key: number;
  description: string;
  unitValue: string;
  quantity: string;
}

interface FormState {
  locale: PaymentOrderLocale;
  issue_date: string;
  payment_date: string;
  beneficiary_id: string | null;
  beneficiary_name: string;
  beneficiary_tax_id: string;
  beneficiary_email: string;
  beneficiary_country: string;
  save_beneficiary: boolean;
  currency: string;
  fees: string;
  payment_method: PaymentMethod;
  crypto_network: string;
  crypto_network_other: string;
  crypto_wallet: string;
  crypto_memo: string;
  bank_name: string;
  bank_account_holder: string;
  bank_account_number: string;
  bank_swift: string;
  bank_account_type: string;
  notes: string;
}

let lineSeq = 0;
const emptyLine = (): LineDraft => ({ key: ++lineSeq, description: '', unitValue: '', quantity: '1' });

function initialState(order: PaymentOrder | undefined, fallbackCurrency: string): FormState {
  const knownNetwork =
    order?.crypto_network && (CRYPTO_NETWORKS as readonly string[]).includes(order.crypto_network);
  return {
    locale: order?.locale ?? 'es',
    issue_date: order?.issue_date ?? todayUtcISO(),
    payment_date: order?.payment_date ?? '',
    beneficiary_id: order?.beneficiary_id ?? null,
    beneficiary_name: order?.beneficiary_name ?? '',
    beneficiary_tax_id: order?.beneficiary_tax_id ?? '',
    beneficiary_email: order?.beneficiary_email ?? '',
    beneficiary_country: order?.beneficiary_country ?? '',
    // Encendido por defecto (pedido de Kevin 2026-08-08): el beneficiario y su
    // medio de pago quedan en la libreta sin gesto extra, y editar la wallet
    // en una orden convierte ese dato en el nuevo default. Se puede apagar
    // para un pago excepcional que no deba pisar la libreta.
    save_beneficiary: true,
    currency: order?.currency ?? fallbackCurrency,
    fees: order ? String(order.fees ?? 0) : '',
    payment_method: order?.payment_method ?? 'crypto',
    crypto_network: order?.crypto_network ? (knownNetwork ? order.crypto_network : OTHER_NETWORK) : '',
    crypto_network_other: order?.crypto_network && !knownNetwork ? order.crypto_network : '',
    crypto_wallet: order?.crypto_wallet ?? '',
    crypto_memo: order?.crypto_memo ?? '',
    bank_name: order?.bank_name ?? '',
    bank_account_holder: order?.bank_account_holder ?? '',
    bank_account_number: order?.bank_account_number ?? '',
    bank_swift: order?.bank_swift ?? '',
    bank_account_type: order?.bank_account_type ?? '',
    notes: order?.notes ?? '',
  };
}

interface Props {
  mode: 'create' | 'edit';
  order?: PaymentOrder;
}

export function PaymentOrderForm({ mode, order }: Props) {
  const { t } = useI18n();
  const router = useRouter();
  const { company } = useData();
  const { toast, ToastHost } = useToasts();

  const [form, setForm] = useState<FormState>(() => initialState(order, company?.currency ?? 'USD'));
  const [lines, setLines] = useState<LineDraft[]>(() =>
    order && order.lines.length > 0
      ? order.lines.map((l) => ({
          key: ++lineSeq,
          description: l.description,
          unitValue: String(l.unitValue ?? ''),
          quantity: String(l.quantity ?? ''),
        }))
      : [emptyLine()],
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<null | 'draft' | 'submit'>(null);

  // ── Documentos de respaldo (opcionales, hasta MAX_PAYMENT_ATTACHMENTS) ─────
  // En alta todavía no hay id de orden, así que los archivos se quedan en state
  // y se suben DESPUÉS de guardar, en su propio try: son adjuntos opcionales,
  // un fallo al subirlos nunca puede desandar ni bloquear la orden ya guardada.
  // En edición se sigue el mismo camino para que "guardar" sea un solo gesto.
  const attachInputRef = useRef<HTMLInputElement>(null);
  /** Elegidos y todavía sin subir. */
  const [attachFiles, setAttachFiles] = useState<File[]>([]);
  /** Ids de respaldos YA guardados que se quitan al guardar (solo en edición). */
  const [attachRemovedIds, setAttachRemovedIds] = useState<string[]>([]);
  const [attachError, setAttachError] = useState('');

  /**
   * Respaldos ya guardados que siguen vigentes (no se marcaron para quitar).
   *
   * Fallback legado: una orden anterior a la migración 127 (o cuyo backfill no
   * corrió) no trae `attachments` pero sí las columnas attachment_*. Sin esta
   * rama, abrir a editar esa orden mostraría "sin respaldo" y nadie vería un
   * error — el fallo silencioso que este repo persigue.
   */
  const savedAttachments = useMemo<PaymentOrderAttachment[]>(() => {
    const list: PaymentOrderAttachment[] =
      order?.attachments && order.attachments.length > 0
        ? order.attachments
        : order?.attachment_path
          ? [{
              id: LEGACY_ATTACHMENT_ID,
              file_name: order.attachment_name,
              mime: order.attachment_mime,
              size: order.attachment_size,
              uploaded_at: order.attachment_uploaded_at ?? '',
            }]
          : [];
    return list.filter((a) => !attachRemovedIds.includes(a.id));
  }, [order, attachRemovedIds]);

  /** Cuántos habrá después de guardar: los que quedan más los elegidos. */
  const attachTotal = savedAttachments.length + attachFiles.length;
  const attachLeft = MAX_PAYMENT_ATTACHMENTS - attachTotal;

  function onAttachPicked(picked: File[]) {
    if (picked.length === 0) return;
    // Los dos chequeos que el servidor repite (él es la autoridad): acá solo
    // evitan un round-trip perdido. Ninguno es silencioso: si no entran, se
    // dice cuántos entran.
    if (picked.some((f) => f.size > MAX_ATTACHMENT_BYTES)) {
      setAttachError(t('payOrders.attachTooLarge'));
      return;
    }
    if (picked.length > attachLeft) {
      setAttachError(t('payOrders.attachTooMany', { max: String(MAX_PAYMENT_ATTACHMENTS) }));
      return;
    }
    setAttachError('');
    // Acumulativo: cada pasada por el input SUMA a lo ya elegido (así se pueden
    // juntar archivos de carpetas distintas sin perder los anteriores).
    setAttachFiles((prev) => [...prev, ...picked]);
  }

  /**
   * Sincroniza los respaldos con la orden ya guardada: primero los borrados,
   * después las subidas (una por request, ver uploadOrderAttachments). Devuelve
   * el mensaje de error si algo falló — el caller lo muestra como aviso, NUNCA
   * como fallo del guardado, y lo que sí entró queda arriba.
   */
  async function syncAttachments(orderId: string): Promise<string | null> {
    const problems: string[] = [];
    for (const removedId of attachRemovedIds) {
      try {
        await deleteOrderAttachment(orderId, removedId);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : t('payOrders.attachError'));
      }
    }
    if (attachFiles.length > 0) {
      try {
        const { failures } = await uploadOrderAttachments(orderId, attachFiles);
        for (const f of failures) problems.push(`${f.name}: ${f.error}`);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : t('payOrders.attachError'));
      }
    }
    return problems.length > 0 ? problems.join(' · ') : null;
  }

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key as string] ? { ...prev, [key as string]: '' } : prev));
  }, []);

  // ── Moneda de la empresa ───────────────────────────────────────────────────
  // Ver la nota de allowedCurrencies: el egreso que nace de una OP pagada no
  // lleva moneda ni conversión, así que la orden se emite en la de la empresa.
  const companyCurrency = (company?.currency || 'USD').toUpperCase();
  const allowed = useMemo(() => allowedCurrencies(companyCurrency), [companyCurrency]);
  /** La moneda guardada de una OP vieja sigue en la lista: se avisa, no se reescribe sola. */
  const currencyOptions = useMemo(
    () => Array.from(new Set([...allowed, form.currency])),
    [allowed, form.currency],
  );
  const currencyMismatch = !allowed.includes(form.currency);

  // `company` llega asincrónico: el estado inicial arranca en 'USD' y hay que
  // corregirlo cuando la empresa carga — pero solo en alta y solo si el
  // usuario todavía no eligió a mano (no le pisamos un USDT deliberado).
  const currencyTouched = useRef(false);
  useEffect(() => {
    if (mode !== 'create' || currencyTouched.current) return;
    setForm((prev) => (prev.currency === companyCurrency ? prev : { ...prev, currency: companyCurrency }));
  }, [mode, companyCurrency]);

  // ── Libreta de beneficiarios ───────────────────────────────────────────────
  const [beneficiaries, setBeneficiaries] = useState<PaymentBeneficiary[]>([]);
  useEffect(() => {
    let alive = true;
    listBeneficiaries()
      .then((rows) => {
        if (alive) setBeneficiaries(rows ?? []);
      })
      .catch(() => {
        /* La libreta es una ayuda, no un requisito: si falla, se tipea a mano. */
      });
    return () => {
      alive = false;
    };
  }, []);

  // ── Conceptos ya facturados a este beneficiario ────────────────────────────
  // Se recargan cada vez que cambia el beneficiario elegido. Es una ayuda:
  // si el fetch falla, el campo sigue siendo texto libre.
  const [lineSuggestions, setLineSuggestions] = useState<LineSuggestion[]>([]);
  const benKey = `${form.beneficiary_id ?? ''}|${form.beneficiary_name.trim().toLowerCase()}`;
  useEffect(() => {
    const [id, name] = benKey.split('|');
    if (!id && name.length < 3) {
      setLineSuggestions([]);
      return;
    }
    let alive = true;
    // Pequeño respiro: sin esto se dispararía una consulta por tecla mientras
    // se escribe el nombre a mano.
    const timer = setTimeout(() => {
      listLineSuggestions({ beneficiaryId: id || null, name: form.beneficiary_name })
        .then((rows) => { if (alive) setLineSuggestions(rows); })
        .catch(() => { if (alive) setLineSuggestions([]); });
    }, 350);
    return () => { alive = false; clearTimeout(timer); };
    // form.beneficiary_name entra vía benKey; incluirlo dispararía de más.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [benKey]);

  const [benOpen, setBenOpen] = useState(false);
  const [benHighlight, setBenHighlight] = useState(0);
  const benBoxRef = useRef<HTMLDivElement>(null);

  const benMatches = useMemo(() => {
    const q = form.beneficiary_name.trim().toLowerCase();
    const pool = q
      ? beneficiaries.filter(
          (b) =>
            b.name.toLowerCase().includes(q) ||
            (b.tax_id ?? '').toLowerCase().includes(q) ||
            (b.email ?? '').toLowerCase().includes(q),
        )
      : beneficiaries;
    return pool.slice(0, 8);
  }, [beneficiaries, form.beneficiary_name]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (benBoxRef.current && !benBoxRef.current.contains(e.target as Node)) setBenOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const pickBeneficiary = useCallback((b: PaymentBeneficiary) => {
    const knownNetwork =
      b.crypto_network && (CRYPTO_NETWORKS as readonly string[]).includes(b.crypto_network);
    setForm((prev) => ({
      ...prev,
      beneficiary_id: b.id,
      beneficiary_name: b.name,
      beneficiary_tax_id: b.tax_id ?? '',
      beneficiary_email: b.email ?? '',
      beneficiary_country: b.country ?? '',
      payment_method: b.default_payment_method ?? prev.payment_method,
      crypto_network: b.crypto_network ? (knownNetwork ? b.crypto_network : OTHER_NETWORK) : prev.crypto_network,
      crypto_network_other: b.crypto_network && !knownNetwork ? b.crypto_network : prev.crypto_network_other,
      crypto_wallet: b.crypto_wallet ?? prev.crypto_wallet,
      crypto_memo: b.crypto_memo ?? prev.crypto_memo,
      bank_name: b.bank_name ?? prev.bank_name,
      bank_account_holder: b.bank_account_holder ?? prev.bank_account_holder,
      bank_account_number: b.bank_account_number ?? prev.bank_account_number,
      bank_swift: b.bank_swift ?? prev.bank_swift,
      bank_account_type: b.bank_account_type ?? prev.bank_account_type,
    }));
    setErrors({});
    setBenOpen(false);
  }, []);

  // ── Totales en vivo (mismas funciones que el servidor) ─────────────────────
  const totals = useMemo(
    () =>
      computeTotals(
        lines.map((l) => ({
          description: l.description,
          unitValue: num(l.unitValue),
          quantity: num(l.quantity),
          amount: 0,
        })),
        num(form.fees),
      ),
    [lines, form.fees],
  );

  const updateLine = (key: number, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setErrors((prev) => {
      const next = { ...prev };
      delete next.lines;
      delete next[`line.${key}.description`];
      delete next[`line.${key}.amount`];
      return next;
    });
  };

  const resolvedNetwork =
    form.crypto_network === OTHER_NETWORK ? form.crypto_network_other.trim() : form.crypto_network;

  // ── Validación (espeja las reglas del endpoint) ────────────────────────────
  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.issue_date) e.issue_date = t('payOrders.errIssueDate');
    if (!form.beneficiary_name.trim()) e.beneficiary_name = t('payOrders.errBeneficiary');

    let hasValidLine = false;
    lines.forEach((l, i) => {
      const amount = computeLineAmount({ unitValue: num(l.unitValue), quantity: num(l.quantity) });
      const described = l.description.trim().length > 0;
      const filled = described || l.unitValue !== '' || amount > 0;
      if (!filled && lines.length > 1) return; // fila en blanco de más: se ignora
      if (described && amount > 0) {
        hasValidLine = true;
        return;
      }
      if (!described) e[`line.${l.key}.description`] = t('payOrders.errLineDescription');
      if (amount <= 0) e[`line.${l.key}.amount`] = t('payOrders.errLineAmount');
      void i;
    });
    if (!hasValidLine) e.lines = t('payOrders.errLines');

    if (form.payment_method === 'crypto') {
      if (!resolvedNetwork) e.crypto_network = t('payOrders.errNetwork');
      if (!form.crypto_wallet.trim()) e.crypto_wallet = t('payOrders.errWallet');
    } else {
      if (!form.bank_name.trim()) e.bank_name = t('payOrders.errBank');
      if (!form.bank_account_holder.trim()) e.bank_account_holder = t('payOrders.errHolder');
      if (!form.bank_account_number.trim()) e.bank_account_number = t('payOrders.errAccount');
    }

    setErrors(e);
    if (Object.keys(e).length > 0) {
      toast.error(t('payOrders.errFix'));
      return false;
    }
    return true;
  }

  function buildInput(): PaymentOrderInput {
    // Solo viajan las líneas con contenido real. computeTotals normaliza y
    // redondea igual que el servidor.
    const usable = lines.filter(
      (l) =>
        l.description.trim().length > 0 ||
        computeLineAmount({ unitValue: num(l.unitValue), quantity: num(l.quantity) }) > 0,
    );
    const normalized = computeTotals(
      usable.map((l) => ({
        description: l.description,
        unitValue: num(l.unitValue),
        quantity: num(l.quantity),
        amount: 0,
      })),
      num(form.fees),
    );
    const crypto = form.payment_method === 'crypto';
    return {
      locale: form.locale,
      issue_date: form.issue_date,
      payment_date: form.payment_date || null,
      beneficiary_id: form.beneficiary_id,
      beneficiary_name: form.beneficiary_name.trim(),
      beneficiary_tax_id: form.beneficiary_tax_id.trim() || null,
      beneficiary_email: form.beneficiary_email.trim() || null,
      beneficiary_country: form.beneficiary_country.trim() || null,
      lines: normalized.lines,
      currency: form.currency,
      fees: normalized.fees,
      payment_method: form.payment_method,
      crypto_network: crypto ? resolvedNetwork : null,
      crypto_wallet: crypto ? form.crypto_wallet.trim() : null,
      crypto_memo: crypto ? form.crypto_memo.trim() || null : null,
      bank_name: crypto ? null : form.bank_name.trim(),
      bank_account_holder: crypto ? null : form.bank_account_holder.trim(),
      bank_account_number: crypto ? null : form.bank_account_number.trim(),
      bank_swift: crypto ? null : form.bank_swift.trim() || null,
      bank_account_type: crypto ? null : form.bank_account_type || null,
      notes: form.notes.trim() || null,
      save_beneficiary: form.save_beneficiary,
    };
  }

  async function handleSave(action: 'draft' | 'submit') {
    if (saving) return;
    if (!validate()) return;
    setSaving(action);
    try {
      const input = buildInput();
      const saved = mode === 'edit' && order ? await updatePaymentOrder(order.id, input) : await createPaymentOrder(input);
      const id = saved?.id ?? order?.id;

      // Los adjuntos van DESPUÉS del guardado y antes de la transición: si
      // alguno falla, solo se avisa (con nombre y motivo) — la orden ya está
      // guardada y no se toca, y los que sí subieron quedan.
      const attachIssue = id ? await syncAttachments(id) : null;

      if (action === 'submit' && id) {
        await transitionPaymentOrder(id, 'pending');
        toast.success(t('payOrders.savedSubmitted'));
      } else {
        toast.success(t('payOrders.savedDraft'));
      }
      if (attachIssue) {
        toast.error(t('payOrders.attachErrorAfterSave', { error: attachIssue }));
      }
      router.push(id ? `/ordenes-pago/${id}` : '/ordenes-pago');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('payOrders.saveError'));
      setSaving(null);
    }
  }

  /** Moneda para mostrar los montos (USDT se muestra como USD, igual que el resto). */
  const displayCurrency = form.currency === 'USDT' ? 'USD' : form.currency;

  return (
    <>
      {ToastHost}
      <form
        className="space-y-4 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          handleSave('submit');
        }}
      >
        {/* ── Datos de la orden ─────────────────────────────────────────── */}
        <Panel title={t('payOrders.sectionOrder')} bodyClassName="space-y-4">
          <div className="space-y-1">
            <span id="po-doc-language" className="block text-[12.5px] font-medium text-text-2">
              {t('payOrders.docLanguage')}
            </span>
            <Segmented<PaymentOrderLocale>
              aria-label={t('payOrders.docLanguage')}
              value={form.locale}
              onChange={(v) => set('locale', v)}
              options={[
                { value: 'es', label: 'Español' },
                { value: 'en', label: 'English' },
              ]}
            />
            <p className="text-[12px] leading-4 text-text-3">{t('payOrders.docLanguageHint')}</p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={t('payOrders.issueDate')} required error={errors.issue_date || undefined}>
              <Input type="date" value={form.issue_date} onChange={(e) => set('issue_date', e.target.value)} />
            </Field>
            <Field label={t('payOrders.paymentDate')} hint={t('payOrders.optional')}>
              <Input type="date" value={form.payment_date} onChange={(e) => set('payment_date', e.target.value)} />
            </Field>
            <Field label={t('payOrders.currency')} hint={t('payOrders.currencyHint', { list: allowed.join(' / ') })}>
              <Select
                value={form.currency}
                aria-invalid={currencyMismatch || undefined}
                onChange={(e) => {
                  currencyTouched.current = true;
                  set('currency', e.target.value);
                }}
              >
                {currencyOptions.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {/* OP vieja en una moneda que la contabilidad no sabe convertir. Se
              avisa y se deja seguir: bloquear la edición de un borrador ya
              guardado sería peor que explicar el problema. */}
          {currencyMismatch && (
            <Notice kind="pend" title={t('payOrders.currency')}>
              {t('payOrders.currencyMismatch', { order: form.currency, company: companyCurrency })}
            </Notice>
          )}
        </Panel>

        {/* ── Beneficiario ──────────────────────────────────────────────── */}
        <Panel title={t('payOrders.sectionBeneficiary')} bodyClassName="space-y-4">
          <div ref={benBoxRef} className="relative">
            <Field
              label={t('payOrders.benName')}
              required
              error={errors.beneficiary_name || undefined}
              hint={form.beneficiary_id ? t('payOrders.benLoaded') : undefined}
            >
              <Input
                value={form.beneficiary_name}
                onChange={(e) => {
                  // Tipear un nombre nuevo desvincula de la libreta: la orden
                  // guarda su propia foto de los datos.
                  setForm((prev) => ({ ...prev, beneficiary_name: e.target.value, beneficiary_id: null }));
                  setErrors((prev) => ({ ...prev, beneficiary_name: '' }));
                  setBenOpen(true);
                  setBenHighlight(0);
                }}
                onFocus={() => setBenOpen(true)}
                onBlur={() => {
                  // Tipear el nombre completo sin clickear la sugerencia debe
                  // comportarse igual que elegirla: si hay match exacto en la
                  // libreta y aún no está vinculado, se vincula y el medio de
                  // pago aparece por defecto. Solo en blur y solo si no está
                  // ya vinculado — así no pisa una wallet editada a propósito.
                  const q = form.beneficiary_name.trim().toLowerCase();
                  if (!q) return;
                  const exact = beneficiaries.find((b) => b.name.trim().toLowerCase() === q);
                  if (exact && form.beneficiary_id !== exact.id) pickBeneficiary(exact);
                }}
                onKeyDown={(e) => {
                  if (!benOpen || benMatches.length === 0) return;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setBenHighlight((i) => Math.min(benMatches.length - 1, i + 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setBenHighlight((i) => Math.max(0, i - 1));
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    pickBeneficiary(benMatches[benHighlight]);
                  } else if (e.key === 'Escape') {
                    setBenOpen(false);
                  }
                }}
                placeholder={t('payOrders.benSearchPlaceholder')}
                autoComplete="off"
                role="combobox"
                aria-expanded={benOpen && benMatches.length > 0}
                aria-controls="po-beneficiary-listbox"
                aria-autocomplete="list"
              />
            </Field>
            {benOpen && benMatches.length > 0 && (
              <ul
                id="po-beneficiary-listbox"
                role="listbox"
                className="absolute top-[60px] z-30 max-h-64 w-full overflow-y-auto rounded-ui-md border border-border bg-card py-1 shadow-2"
              >
                {benMatches.map((b, i) => (
                  <li key={b.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === benHighlight}
                      onMouseEnter={() => setBenHighlight(i)}
                      onClick={() => pickBeneficiary(b)}
                      className={cn(
                        'flex w-full items-start gap-2 px-3 py-2 text-left',
                        i === benHighlight ? 'bg-row-selected' : 'hover:bg-row-hover',
                      )}
                    >
                      <BookUser aria-hidden className="mt-0.5 size-4 shrink-0 text-text-3" />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-foreground">{b.name}</span>
                        <span className="block truncate text-[12px] text-text-3">
                          {[b.tax_id, b.country, b.default_payment_method === 'bank' ? b.bank_name : b.crypto_network]
                            .filter(Boolean)
                            .join(' · ') || t('payOrders.benNoData')}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label={t('payOrders.benTaxId')}>
              <Input value={form.beneficiary_tax_id} onChange={(e) => set('beneficiary_tax_id', e.target.value)} />
            </Field>
            <Field label={t('payOrders.benEmail')}>
              <Input
                type="email"
                value={form.beneficiary_email}
                onChange={(e) => set('beneficiary_email', e.target.value)}
              />
            </Field>
            <Field label={t('payOrders.benCountry')}>
              <Input value={form.beneficiary_country} onChange={(e) => set('beneficiary_country', e.target.value)} />
            </Field>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={form.save_beneficiary}
              onChange={(e) => set('save_beneficiary', e.target.checked)}
              className="mt-0.5 size-4 rounded-ui-sm border-control-border accent-primary"
            />
            <span>
              <span className="block text-[13px] font-medium text-foreground">{t('payOrders.benSave')}</span>
              <span className="block text-[12px] text-text-3">{t('payOrders.benSaveHint')}</span>
            </span>
          </label>
        </Panel>

        {/* ── Detalle del pago (líneas) ─────────────────────────────────── */}
        {/* Grilla alineada con los tokens de FinTable (cabecera 11.5 MAYÚSCULAS
            `text-3` sobre `border-strong`, filas con borde `border`, montos a la
            derecha y tabulares, pie con la doble raya en el total). No es la
            FinTable porque cada celda es un control: FinTable dibuja valores. */}
        <Panel
          title={t('payOrders.sectionLines')}
          hint={t('payOrders.linesHint', { n: String(lines.length) })}
          flush
          actions={
            <ActionButton onClick={() => setLines((prev) => [...prev, emptyLine()])}>
              <Plus aria-hidden className="size-4" />
              {t('payOrders.addLine')}
            </ActionButton>
          }
        >
          {/* Un solo datalist para todas las líneas: el navegador lo comparte por
              id y los conceptos sugeridos son los mismos en cada fila. */}
          <datalist id="payorder-line-suggestions">
            {lineSuggestions.map((sg) => (
              <option key={sg.description} value={sg.description} />
            ))}
          </datalist>

          <div role="table" aria-label={t('payOrders.sectionLines')} className="text-[13px]">
            <div
              role="row"
              className={cn(
                LINE_GRID,
                'h-[34px] border-b border-border-strong text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3 max-sm:hidden',
              )}
            >
              <span role="columnheader">{t('payOrders.lineDescription')}</span>
              <span role="columnheader" className="text-right">
                {t('payOrders.lineUnitValue')}
              </span>
              <span role="columnheader" className="text-right">
                {t('payOrders.lineQuantity')}
              </span>
              <span role="columnheader" className="text-right">
                {t('payOrders.lineAmount')}
              </span>
              <span role="columnheader" className="sr-only">
                {t('ui.table.actions')}
              </span>
            </div>

            {lines.map((line, i) => {
              const amount = computeLineAmount({ unitValue: num(line.unitValue), quantity: num(line.quantity) });
              const descErr = errors[`line.${line.key}.description`];
              const amtErr = errors[`line.${line.key}.amount`];
              const errId = descErr || amtErr ? `po-line-${line.key}-err` : undefined;
              return (
                <div key={line.key} role="row" className="border-b border-border py-2 max-sm:py-3">
                  <div className={cn(LINE_GRID, 'max-sm:gap-y-2')}>
                    <div role="cell" className="max-sm:col-span-2">
                      <Input
                        value={line.description}
                        list="payorder-line-suggestions"
                        onChange={(e) => {
                          const description = e.target.value;
                          // Elegir un concepto ya usado trae su último importe,
                          // pero SOLO si el campo está vacío: nunca pisa un
                          // número que el usuario ya escribió.
                          const hit = lineSuggestions.find(
                            (sg) => sg.description.toLowerCase() === description.trim().toLowerCase(),
                          );
                          const patch: Partial<LineDraft> = { description };
                          if (hit?.lastUnitValue != null && !line.unitValue.trim()) {
                            patch.unitValue = String(hit.lastUnitValue);
                          }
                          updateLine(line.key, patch);
                        }}
                        placeholder={t('payOrders.linePlaceholder')}
                        aria-label={`${t('payOrders.lineDescription')} ${i + 1}`}
                        aria-invalid={descErr ? true : undefined}
                        aria-describedby={errId}
                        className={cn(descErr && 'border-neg')}
                      />
                    </div>
                    <div role="cell">
                      <span aria-hidden className="mb-1 block text-[12px] text-text-3 sm:hidden">
                        {t('payOrders.lineUnitValue')}
                      </span>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        inputMode="decimal"
                        value={line.unitValue}
                        onChange={(e) => updateLine(line.key, { unitValue: e.target.value })}
                        placeholder="0.00"
                        aria-label={`${t('payOrders.lineUnitValue')} ${i + 1}`}
                        aria-invalid={amtErr ? true : undefined}
                        aria-describedby={errId}
                        className={cn('text-right tabular-nums', amtErr && 'border-neg')}
                      />
                    </div>
                    <div role="cell">
                      <span aria-hidden className="mb-1 block text-[12px] text-text-3 sm:hidden">
                        {t('payOrders.lineQuantity')}
                      </span>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                        placeholder="1"
                        aria-label={`${t('payOrders.lineQuantity')} ${i + 1}`}
                        aria-invalid={amtErr ? true : undefined}
                        aria-describedby={errId}
                        className={cn('text-right tabular-nums', amtErr && 'border-neg')}
                      />
                    </div>
                    {/* Read-only: el monto es SIEMPRE derivado (computeLineAmount). */}
                    <output role="cell" className="self-center text-left sm:text-right">
                      <span className="mr-2 text-[12px] text-text-3 sm:hidden">{t('payOrders.lineAmount')}</span>
                      <Money value={amount} currency={displayCurrency} className="font-medium" />
                    </output>
                    <div role="cell" className="flex justify-end self-center">
                      <button
                        type="button"
                        className={cn(ROW_ACTION_CLASS, 'hover:text-neg')}
                        aria-label={t('payOrders.removeLine', { n: String(i + 1) })}
                        title={t('payOrders.removeLine', { n: String(i + 1) })}
                        disabled={lines.length === 1}
                        onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                      >
                        <Trash2 aria-hidden className="size-4" strokeWidth={1.75} />
                      </button>
                    </div>
                  </div>
                  {(descErr || amtErr) && (
                    <p id={errId} className="mt-1 flex items-start gap-1 text-[12px] leading-4 text-neg">
                      <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" strokeWidth={2} />
                      <span>{descErr || amtErr}</span>
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {errors.lines && (
            <p className="flex items-start gap-1 px-4 pt-2 text-[12px] leading-4 text-neg">
              <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" strokeWidth={2} />
              <span>{errors.lines}</span>
            </p>
          )}

          {/* Totales — siempre derivados de computeTotals(). */}
          <dl className="text-[13px]">
            <div className="flex h-9 items-center justify-end gap-6 px-4 text-text-2">
              <dt>{t('payOrders.subtotal')}</dt>
              <dd className="w-40 text-right">
                <Money value={totals.subtotal} currency={displayCurrency} className="font-medium" />
              </dd>
            </div>
            <div className="flex min-h-11 items-center justify-end gap-6 px-4 text-text-2">
              <dt>
                <label htmlFor="po-fees">{t('payOrders.fees')}</label>
              </dt>
              <dd className="w-40">
                <Input
                  id="po-fees"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={form.fees}
                  onChange={(e) => set('fees', e.target.value)}
                  placeholder="0.00"
                  className="text-right tabular-nums"
                />
              </dd>
            </div>
            <div className="flex h-[42px] items-center justify-end gap-6 px-4 font-[650] text-foreground shadow-[inset_0_1.5px_0_0_var(--foreground)]">
              <dt>{t('payOrders.total')}</dt>
              <dd className="w-40 text-right">
                <Money value={totals.total} currency={displayCurrency} className="text-[15px]" />
              </dd>
            </div>
          </dl>
        </Panel>

        {/* ── Medio de pago ─────────────────────────────────────────────── */}
        <Panel title={t('payOrders.sectionMethod')} bodyClassName="space-y-4">
          <Segmented<PaymentMethod>
            aria-label={t('payOrders.sectionMethod')}
            value={form.payment_method}
            onChange={(v) => set('payment_method', v)}
            options={[
              {
                value: 'crypto',
                label: (
                  <>
                    <Wallet aria-hidden className="size-3.5" />
                    {t('payOrders.methodCryptoFull')}
                  </>
                ),
              },
              {
                value: 'bank',
                label: (
                  <>
                    <Landmark aria-hidden className="size-3.5" />
                    {t('payOrders.methodBankFull')}
                  </>
                ),
              },
            ]}
          />

          {form.payment_method === 'crypto' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('payOrders.network')} required error={errors.crypto_network || undefined}>
                  <Select value={form.crypto_network} onChange={(e) => set('crypto_network', e.target.value)}>
                    <option value="">{t('payOrders.networkSelect')}</option>
                    {CRYPTO_NETWORKS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                    <option value={OTHER_NETWORK}>{t('payOrders.networkOther')}</option>
                  </Select>
                </Field>
                {form.crypto_network === OTHER_NETWORK && (
                  <Field label={t('payOrders.networkOtherLabel')} required error={errors.crypto_network || undefined}>
                    <Input
                      value={form.crypto_network_other}
                      onChange={(e) => set('crypto_network_other', e.target.value)}
                    />
                  </Field>
                )}
              </div>

              <Field label={t('payOrders.wallet')} required error={errors.crypto_wallet || undefined}>
                <Input
                  value={form.crypto_wallet}
                  onChange={(e) => set('crypto_wallet', e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="T… / 0x…"
                  className="font-mono"
                />
              </Field>

              {/* Una wallet mal tipeada = fondos perdidos. El aviso va pegado
                  al campo, no en un tooltip que nadie abre. */}
              <Notice kind="pend" title={t('payOrders.walletWarningTitle')}>
                {t('payOrders.walletWarning')}
              </Notice>

              <Field label={t('payOrders.memo')} hint={t('payOrders.optional')}>
                <Input
                  value={form.crypto_memo}
                  onChange={(e) => set('crypto_memo', e.target.value)}
                  className="font-mono"
                />
              </Field>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('payOrders.bankName')} required error={errors.bank_name || undefined}>
                <Input value={form.bank_name} onChange={(e) => set('bank_name', e.target.value)} />
              </Field>
              <Field label={t('payOrders.accountHolder')} required error={errors.bank_account_holder || undefined}>
                <Input
                  value={form.bank_account_holder}
                  onChange={(e) => set('bank_account_holder', e.target.value)}
                />
              </Field>
              <Field label={t('payOrders.accountNumber')} required error={errors.bank_account_number || undefined}>
                <Input
                  value={form.bank_account_number}
                  onChange={(e) => set('bank_account_number', e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono"
                />
              </Field>
              <Field label={t('payOrders.swift')} hint={t('payOrders.optional')}>
                <Input
                  value={form.bank_swift}
                  onChange={(e) => set('bank_swift', e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono"
                />
              </Field>
              <Field label={t('payOrders.accountType')} hint={t('payOrders.optional')}>
                <Select value={form.bank_account_type} onChange={(e) => set('bank_account_type', e.target.value)}>
                  <option value="">{t('payOrders.accountTypeSelect')}</option>
                  <option value="checking">{t('payOrders.accountTypeChecking')}</option>
                  <option value="savings">{t('payOrders.accountTypeSavings')}</option>
                  <option value="other">{t('payOrders.accountTypeOther')}</option>
                </Select>
              </Field>
            </div>
          )}
        </Panel>

        {/* ── Concepto / Observaciones ──────────────────────────────────── */}
        <Panel title={t('payOrders.sectionNotes')}>
          <Textarea
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            rows={4}
            placeholder={t('payOrders.notesPlaceholder')}
            aria-label={t('payOrders.sectionNotes')}
            className="resize-y"
          />
        </Panel>

        {/* ── Documentos de respaldo (opcionales, hasta 10) ────────────────
            Van pegados al concepto porque son su respaldo documental: la
            factura, el contrato o la cotización que justifica el pago. NO
            confundir con el comprobante de pago, que se adjunta al marcar
            la orden como pagada. */}
        <Panel
          title={t('payOrders.attachLabel')}
          hint={
            <span className={NUM_CLASS}>
              {t('payOrders.fileCounter', { n: String(attachTotal), max: String(MAX_PAYMENT_ATTACHMENTS) })}
            </span>
          }
          actions={
            <ActionButton
              aria-label={attachTotal === 0 ? t('payOrders.attachAttach') : t('payOrders.attachAddAria')}
              disabled={attachLeft <= 0}
              onClick={() => attachInputRef.current?.click()}
            >
              <FileText aria-hidden className="size-4" />
              {attachTotal === 0 ? t('payOrders.attachAttach') : t('payOrders.attachAdd')}
            </ActionButton>
          }
          footer={
            attachError ? undefined : attachLeft <= 0
              ? t('payOrders.attachMaxReached', { max: String(MAX_PAYMENT_ATTACHMENTS) })
              : t('payOrders.attachHintMulti', { max: String(MAX_PAYMENT_ATTACHMENTS) })
          }
          bodyClassName="space-y-3"
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
              onAttachPicked(picked);
            }}
          />

          {/* Edición: los que YA están guardados. Se pueden abrir y marcar
              para quitar; el borrado real ocurre al guardar la orden. */}
          {savedAttachments.length > 0 && (
            <SavedFileList
              files={savedAttachments}
              texts={{
                fallbackName: t('payOrders.attachSection'),
                uploadedAt: (date) => t('payOrders.attachUploaded', { date }),
                view: t('payOrders.attachView'),
                viewAria: (name) => t('payOrders.attachViewItemAria', { name }),
                download: t('payOrders.attachDownload'),
                downloadAria: (name) => t('payOrders.attachDownloadAria', { name }),
                remove: t('payOrders.attachRemove'),
                removeAria: (name) => t('payOrders.attachRemoveItemAria', { name }),
              }}
              hrefFor={(f) => orderAttachmentUrl(order!.id, f.id)}
              downloadHrefFor={(f) => orderAttachmentUrl(order!.id, f.id, { download: true })}
              onRemove={(f) => {
                setAttachRemovedIds((prev) => [...prev, f.id]);
                setAttachError('');
              }}
            />
          )}

          {/* Elegidos y todavía sin subir: se suben al guardar. */}
          <PickedFileList
            files={attachFiles}
            onRemove={(i) => {
              setAttachFiles((prev) => prev.filter((_, j) => j !== i));
              setAttachError('');
            }}
            removeAria={(name) => t('payOrders.attachUnselectAria', { name })}
            pendingNote={t('payOrders.attachPending')}
          />

          {savedAttachments.length === 0 && attachFiles.length === 0 && (
            <p className="text-[13px] text-text-3">{t('payOrders.attachNone')}</p>
          )}

          {attachRemovedIds.length > 0 && (
            <Notice
              kind="pend"
              title={
                attachRemovedIds.length === 1
                  ? t('payOrders.attachPendingRemove')
                  : t('payOrders.attachPendingRemoveMany', { count: String(attachRemovedIds.length) })
              }
            />
          )}

          {attachError && <Notice kind="bad" title={attachError} />}
        </Panel>

        {/* ── Barra de acciones pegada abajo ────────────────────────────── */}
        <div className="sticky bottom-0 z-20 -mx-4 flex flex-col gap-3 border-t border-border bg-card px-4 py-3 shadow-2 sm:mx-0 sm:flex-row sm:items-center sm:rounded-ui-lg sm:border sm:px-4">
          <div className="flex items-baseline gap-2 sm:mr-auto">
            <span className="text-[12px] font-medium text-text-2">{t('payOrders.total')}</span>
            <Money value={totals.total} currency={displayCurrency} className="text-[18px] font-semibold" />
          </div>
          <div className="flex items-center justify-end gap-2">
            <ActionButton variant="ghost" onClick={() => router.back()} disabled={saving !== null}>
              {t('payOrders.cancel')}
            </ActionButton>
            <ActionButton onClick={() => handleSave('draft')} loading={saving === 'draft'} disabled={saving !== null}>
              {mode === 'edit' ? t('payOrders.saveChanges') : t('payOrders.saveDraft')}
            </ActionButton>
            <ActionButton type="submit" variant="primary" loading={saving === 'submit'} disabled={saving !== null}>
              {t('payOrders.saveAndSubmit')}
            </ActionButton>
          </div>
        </div>
      </form>
    </>
  );
}
