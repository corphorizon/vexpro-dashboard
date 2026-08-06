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
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Trash2, Wallet, Landmark, AlertTriangle, BookUser } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToasts } from '@/components/ui/toast';
import { useI18n } from '@/lib/i18n';
import { useData } from '@/lib/data-context';
import { cn, formatCurrency } from '@/lib/utils';
import {
  CRYPTO_NETWORKS,
  computeLineAmount,
  computeTotals,
  type PaymentBeneficiary,
  type PaymentMethod,
  type PaymentOrder,
  type PaymentOrderInput,
  type PaymentOrderLocale,
} from '@/lib/payment-orders/types';
// NOTA: estas helpers las escribe el módulo hermano (src/lib/payment-orders/api.ts).
// Firmas asumidas: createPaymentOrder(input), updatePaymentOrder(id, input),
// transitionPaymentOrder(id, to, payload?), listBeneficiaries().
import {
  createPaymentOrder,
  updatePaymentOrder,
  transitionPaymentOrder,
  listBeneficiaries,
} from '@/lib/payment-orders/api';

const INPUT =
  'w-full px-3 py-2 rounded-lg border border-border bg-card text-base sm:text-sm placeholder:text-muted-foreground';
const INPUT_ERR = 'border-negative';

const CURRENCIES = ['USD', 'USDT', 'EUR', 'GBP', 'ARS', 'MXN', 'BRL'];
const OTHER_NETWORK = '__other__';

function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
    issue_date: order?.issue_date ?? todayISO(),
    payment_date: order?.payment_date ?? '',
    beneficiary_id: order?.beneficiary_id ?? null,
    beneficiary_name: order?.beneficiary_name ?? '',
    beneficiary_tax_id: order?.beneficiary_tax_id ?? '',
    beneficiary_email: order?.beneficiary_email ?? '',
    beneficiary_country: order?.beneficiary_country ?? '',
    save_beneficiary: false,
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

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => (prev[key as string] ? { ...prev, [key as string]: '' } : prev));
  }, []);

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
      if (action === 'submit' && id) {
        await transitionPaymentOrder(id, 'pending');
        toast.success(t('payOrders.savedSubmitted'));
      } else {
        toast.success(t('payOrders.savedDraft'));
      }
      router.push(id ? `/ordenes-pago/${id}` : '/ordenes-pago');
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('payOrders.saveError'));
      setSaving(null);
    }
  }

  const money = (n: number) => formatCurrency(n, form.currency === 'USDT' ? 'USD' : form.currency);

  return (
    <>
      {ToastHost}
      <form
        className="space-y-6 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          handleSave('submit');
        }}
      >
        {/* ── Datos de la orden ─────────────────────────────────────────── */}
        <Card className="space-y-4">
          <SectionTitle>{t('payOrders.sectionOrder')}</SectionTitle>

          <div>
            <Label>{t('payOrders.docLanguage')}</Label>
            <Segmented
              value={form.locale}
              onChange={(v) => set('locale', v as PaymentOrderLocale)}
              options={[
                { value: 'es', label: 'Español' },
                { value: 'en', label: 'English' },
              ]}
            />
            <p className="text-xs text-muted-foreground mt-1.5">{t('payOrders.docLanguageHint')}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label={t('payOrders.issueDate')} required error={errors.issue_date}>
              <input
                type="date"
                value={form.issue_date}
                onChange={(e) => set('issue_date', e.target.value)}
                className={cn(INPUT, errors.issue_date && INPUT_ERR)}
              />
            </Field>
            <Field label={t('payOrders.paymentDate')} hint={t('payOrders.optional')}>
              <input
                type="date"
                value={form.payment_date}
                onChange={(e) => set('payment_date', e.target.value)}
                className={INPUT}
              />
            </Field>
            <Field label={t('payOrders.currency')}>
              <select
                value={form.currency}
                onChange={(e) => set('currency', e.target.value)}
                className={INPUT}
              >
                {Array.from(new Set([form.currency, ...CURRENCIES])).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Card>

        {/* ── Beneficiario ──────────────────────────────────────────────── */}
        <Card className="space-y-4">
          <SectionTitle>{t('payOrders.sectionBeneficiary')}</SectionTitle>

          <div ref={benBoxRef} className="relative">
            <Field label={t('payOrders.benName')} required error={errors.beneficiary_name}>
              <input
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
                className={cn(INPUT, errors.beneficiary_name && INPUT_ERR)}
              />
            </Field>
            {benOpen && benMatches.length > 0 && (
              <ul
                id="po-beneficiary-listbox"
                role="listbox"
                className="absolute z-30 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-border bg-card shadow-[var(--elevation-2)]"
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
                        'w-full text-left px-3 py-2 flex items-start gap-2',
                        i === benHighlight ? 'bg-muted' : 'hover:bg-muted/60',
                      )}
                    >
                      <BookUser className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium truncate">{b.name}</span>
                        <span className="block text-xs text-muted-foreground truncate">
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
            {form.beneficiary_id && (
              <p className="text-xs text-positive mt-1.5">{t('payOrders.benLoaded')}</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Field label={t('payOrders.benTaxId')}>
              <input
                value={form.beneficiary_tax_id}
                onChange={(e) => set('beneficiary_tax_id', e.target.value)}
                className={INPUT}
              />
            </Field>
            <Field label={t('payOrders.benEmail')}>
              <input
                type="email"
                value={form.beneficiary_email}
                onChange={(e) => set('beneficiary_email', e.target.value)}
                className={INPUT}
              />
            </Field>
            <Field label={t('payOrders.benCountry')}>
              <input
                value={form.beneficiary_country}
                onChange={(e) => set('beneficiary_country', e.target.value)}
                className={INPUT}
              />
            </Field>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={form.save_beneficiary}
              onChange={(e) => set('save_beneficiary', e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-border accent-[var(--color-primary)]"
            />
            <span>
              <span className="block text-sm font-medium">{t('payOrders.benSave')}</span>
              <span className="block text-xs text-muted-foreground">{t('payOrders.benSaveHint')}</span>
            </span>
          </label>
        </Card>

        {/* ── Detalle del pago ──────────────────────────────────────────── */}
        <Card className="space-y-4">
          <SectionTitle>{t('payOrders.sectionLines')}</SectionTitle>

          {/* Encabezados solo en desktop; en mobile cada línea es una tarjeta
              con sus propias etiquetas. */}
          <div className="hidden sm:grid grid-cols-12 gap-3 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <div className="col-span-5">{t('payOrders.lineDescription')}</div>
            <div className="col-span-2 text-right">{t('payOrders.lineUnitValue')}</div>
            <div className="col-span-2 text-right">{t('payOrders.lineQuantity')}</div>
            <div className="col-span-2 text-right">{t('payOrders.lineAmount')}</div>
            <div className="col-span-1" />
          </div>

          <div className="space-y-3 sm:space-y-2">
            {lines.map((line, i) => {
              const amount = computeLineAmount({ unitValue: num(line.unitValue), quantity: num(line.quantity) });
              const descErr = errors[`line.${line.key}.description`];
              const amtErr = errors[`line.${line.key}.amount`];
              return (
                <div
                  key={line.key}
                  className="grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-3 sm:items-center rounded-lg border border-border sm:border-0 p-3 sm:p-0"
                >
                  <div className="sm:col-span-5">
                    <span className="sm:hidden block text-xs text-muted-foreground mb-1">
                      {t('payOrders.lineDescription')}
                    </span>
                    <input
                      value={line.description}
                      onChange={(e) => updateLine(line.key, { description: e.target.value })}
                      placeholder={t('payOrders.linePlaceholder')}
                      className={cn(INPUT, descErr && INPUT_ERR)}
                      aria-label={`${t('payOrders.lineDescription')} ${i + 1}`}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <span className="sm:hidden block text-xs text-muted-foreground mb-1">
                      {t('payOrders.lineUnitValue')}
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      inputMode="decimal"
                      value={line.unitValue}
                      onChange={(e) => updateLine(line.key, { unitValue: e.target.value })}
                      placeholder="0.00"
                      className={cn(INPUT, 'text-right tabular-nums', amtErr && INPUT_ERR)}
                      aria-label={`${t('payOrders.lineUnitValue')} ${i + 1}`}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <span className="sm:hidden block text-xs text-muted-foreground mb-1">
                      {t('payOrders.lineQuantity')}
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                      placeholder="1"
                      className={cn(INPUT, 'text-right tabular-nums', amtErr && INPUT_ERR)}
                      aria-label={`${t('payOrders.lineQuantity')} ${i + 1}`}
                    />
                  </div>
                  <div className="sm:col-span-2 flex sm:block items-center justify-between">
                    <span className="sm:hidden text-xs text-muted-foreground">{t('payOrders.lineAmount')}</span>
                    {/* Read-only: el monto es SIEMPRE derivado (computeLineAmount). */}
                    <output className="block sm:text-right text-sm font-medium tabular-nums px-0 sm:px-3 py-2">
                      {money(amount)}
                    </output>
                  </div>
                  <div className="sm:col-span-1 flex sm:justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t('payOrders.removeLine', { n: String(i + 1) })}
                      disabled={lines.length === 1}
                      onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  {(descErr || amtErr) && (
                    <p className="sm:col-span-12 text-xs text-negative">{descErr || amtErr}</p>
                  )}
                </div>
              );
            })}
          </div>

          {errors.lines && <p className="text-xs text-negative">{errors.lines}</p>}

          <Button type="button" variant="secondary" size="sm" onClick={() => setLines((prev) => [...prev, emptyLine()])}>
            <Plus className="w-4 h-4" />
            {t('payOrders.addLine')}
          </Button>

          {/* Totales — siempre derivados de computeTotals(). */}
          <div className="border-t border-border pt-4 space-y-3">
            <div className="flex items-center justify-between gap-4 sm:justify-end sm:gap-8">
              <span className="text-sm text-muted-foreground">{t('payOrders.subtotal')}</span>
              <span className="text-sm font-medium tabular-nums sm:w-40 sm:text-right">{money(totals.subtotal)}</span>
            </div>
            <div className="flex items-center justify-between gap-4 sm:justify-end sm:gap-8">
              <label htmlFor="po-fees" className="text-sm text-muted-foreground">
                {t('payOrders.fees')}
              </label>
              <input
                id="po-fees"
                type="number"
                step="0.01"
                inputMode="decimal"
                value={form.fees}
                onChange={(e) => set('fees', e.target.value)}
                placeholder="0.00"
                className={cn(INPUT, 'text-right tabular-nums w-32 sm:w-40')}
              />
            </div>
            <div className="flex items-center justify-between gap-4 sm:justify-end sm:gap-8 border-t border-border pt-3">
              <span className="text-sm font-semibold uppercase tracking-wide">{t('payOrders.total')}</span>
              <span className="text-2xl sm:text-3xl font-bold tabular-nums sm:w-40 sm:text-right">
                {money(totals.total)}
              </span>
            </div>
          </div>
        </Card>

        {/* ── Medio de pago ─────────────────────────────────────────────── */}
        <Card className="space-y-4">
          <SectionTitle>{t('payOrders.sectionMethod')}</SectionTitle>

          <Segmented
            value={form.payment_method}
            onChange={(v) => set('payment_method', v as PaymentMethod)}
            options={[
              { value: 'crypto', label: t('payOrders.methodCryptoFull'), icon: Wallet },
              { value: 'bank', label: t('payOrders.methodBankFull'), icon: Landmark },
            ]}
          />

          {form.payment_method === 'crypto' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label={t('payOrders.network')} required error={errors.crypto_network}>
                  <select
                    value={form.crypto_network}
                    onChange={(e) => set('crypto_network', e.target.value)}
                    className={cn(INPUT, errors.crypto_network && INPUT_ERR)}
                  >
                    <option value="">{t('payOrders.networkSelect')}</option>
                    {CRYPTO_NETWORKS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                    <option value={OTHER_NETWORK}>{t('payOrders.networkOther')}</option>
                  </select>
                </Field>
                {form.crypto_network === OTHER_NETWORK && (
                  <Field label={t('payOrders.networkOtherLabel')} required error={errors.crypto_network}>
                    <input
                      value={form.crypto_network_other}
                      onChange={(e) => set('crypto_network_other', e.target.value)}
                      className={INPUT}
                    />
                  </Field>
                )}
              </div>

              <Field label={t('payOrders.wallet')} required error={errors.crypto_wallet}>
                <input
                  value={form.crypto_wallet}
                  onChange={(e) => set('crypto_wallet', e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="T… / 0x…"
                  className={cn(INPUT, 'font-mono', errors.crypto_wallet && INPUT_ERR)}
                />
              </Field>

              {/* Una wallet mal tipeada = fondos perdidos. El aviso va pegado
                  al campo, no en un tooltip que nadie abre. */}
              <p className="flex items-start gap-2 text-xs text-warning bg-warning/10 rounded-lg px-3 py-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-px" aria-hidden />
                <span>{t('payOrders.walletWarning')}</span>
              </p>

              <Field label={t('payOrders.memo')} hint={t('payOrders.optional')}>
                <input
                  value={form.crypto_memo}
                  onChange={(e) => set('crypto_memo', e.target.value)}
                  className={cn(INPUT, 'font-mono')}
                />
              </Field>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label={t('payOrders.bankName')} required error={errors.bank_name}>
                <input
                  value={form.bank_name}
                  onChange={(e) => set('bank_name', e.target.value)}
                  className={cn(INPUT, errors.bank_name && INPUT_ERR)}
                />
              </Field>
              <Field label={t('payOrders.accountHolder')} required error={errors.bank_account_holder}>
                <input
                  value={form.bank_account_holder}
                  onChange={(e) => set('bank_account_holder', e.target.value)}
                  className={cn(INPUT, errors.bank_account_holder && INPUT_ERR)}
                />
              </Field>
              <Field label={t('payOrders.accountNumber')} required error={errors.bank_account_number}>
                <input
                  value={form.bank_account_number}
                  onChange={(e) => set('bank_account_number', e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  className={cn(INPUT, 'font-mono', errors.bank_account_number && INPUT_ERR)}
                />
              </Field>
              <Field label={t('payOrders.swift')} hint={t('payOrders.optional')}>
                <input
                  value={form.bank_swift}
                  onChange={(e) => set('bank_swift', e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  className={cn(INPUT, 'font-mono')}
                />
              </Field>
              <Field label={t('payOrders.accountType')} hint={t('payOrders.optional')}>
                <select
                  value={form.bank_account_type}
                  onChange={(e) => set('bank_account_type', e.target.value)}
                  className={INPUT}
                >
                  <option value="">{t('payOrders.accountTypeSelect')}</option>
                  <option value="checking">{t('payOrders.accountTypeChecking')}</option>
                  <option value="savings">{t('payOrders.accountTypeSavings')}</option>
                  <option value="other">{t('payOrders.accountTypeOther')}</option>
                </select>
              </Field>
            </div>
          )}
        </Card>

        {/* ── Concepto / Observaciones ──────────────────────────────────── */}
        <Card className="space-y-4">
          <SectionTitle>{t('payOrders.sectionNotes')}</SectionTitle>
          <textarea
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            rows={4}
            placeholder={t('payOrders.notesPlaceholder')}
            className={cn(INPUT, 'resize-y')}
            aria-label={t('payOrders.sectionNotes')}
          />
        </Card>

        {/* ── Barra de acciones pegada abajo ────────────────────────────── */}
        <div className="sticky bottom-0 z-20 -mx-4 sm:mx-0 px-4 sm:px-5 py-3 border-t sm:border border-border bg-card/95 backdrop-blur sm:rounded-xl shadow-[var(--elevation-2)] flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-baseline gap-2 sm:mr-auto">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">{t('payOrders.total')}</span>
            <span className="text-lg font-bold tabular-nums">{money(totals.total)}</span>
          </div>
          <div className="flex items-center gap-2 justify-end">
            <Button type="button" variant="ghost" onClick={() => router.back()} disabled={saving !== null}>
              {t('payOrders.cancel')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => handleSave('draft')}
              loading={saving === 'draft'}
              disabled={saving !== null}
            >
              {mode === 'edit' ? t('payOrders.saveChanges') : t('payOrders.saveDraft')}
            </Button>
            <Button type="submit" variant="primary" loading={saving === 'submit'} disabled={saving !== null}>
              {t('payOrders.saveAndSubmit')}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}

// ── Primitivas locales del formulario ───────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base font-semibold text-foreground">{children}</h2>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="block text-sm font-medium mb-1.5">{children}</span>;
}

function Field({
  label,
  hint,
  required,
  error,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1.5">
        {label}
        {required && <span className="text-negative"> *</span>}
        {hint && <span className="text-muted-foreground font-normal"> {hint}</span>}
      </span>
      {children}
      {error && <span className="block text-xs text-negative mt-1">{error}</span>}
    </label>
  );
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; icon?: React.ComponentType<{ className?: string }> }[];
}) {
  return (
    <div role="tablist" className="inline-flex p-1 rounded-lg bg-muted gap-1">
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-sm font-medium transition-colors',
              active
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="w-4 h-4" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
