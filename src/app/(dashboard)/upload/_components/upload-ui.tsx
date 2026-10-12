'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Field, Input } from '@/components/ui/field';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';

// ─────────────────────────────────────────────────────────────────────────────
// Recetas «Libro mayor» de Carga de datos (docs/diseno-libro-mayor.md §5).
//
// POR QUÉ (2026-10-12, migración de /upload): la pantalla tenía 82 clases de
// paleta cruda (`text-emerald-600`, `hover:bg-red-50`, `bg-slate-100`…), 23
// variantes `dark:` de color, 13 `text-[10px]/[11px]` y DOS recetas de foco
// en los inputs: 35 con `focus:outline-none focus:ring-2 focus:ring-accent`
// propio y los 16 de la edición inline con el anillo global. Medido con grep
// sobre page.tsx (más 18 crudos / 7 `dark:` en income-lines-section.tsx)
// antes del cambio. Ahora todos son el <Input> de la primitiva, que usa sólo
// el global (field.tsx: «UNA receta»). Además el
// total de Depósitos salía en azul y el de Retiros en rojo: color sin
// significado (§2.1 — un total de una columna de positivos no se pinta).
//
// Acá vive UNA vez lo que comparten las pestañas: botones (misma receta que
// `payment-orders/action-button.tsx` y los `BTN` de Balances, en strings
// locales para no importar de otro módulo), el input de celda y la paginación.
//
// `max-sm:text-base` en los inputs: el `Input` de la primitiva mide 13 px, y
// iOS Safari hace zoom al enfocar un input de menos de 16 px. Los inputs
// viejos de esta pantalla ya tenían `text-base sm:text-sm` por eso; se
// conserva (la utilidad con variante gana a la base en < 640).
//
// DESCARTADO:
//   · Importar `actionButtonClass` de components/payment-orders: acoplaría
//     Carga de datos a Órdenes de pago. Cuando la fase 5 reemplace
//     `ui/button.tsx`, las tres copias (Balances, OP, acá) se van juntas.
//   · Tocar `src/components/ui/**`: lo migran otros; acá sólo se consume.
// ─────────────────────────────────────────────────────────────────────────────

/** Tamaño de página compartido por las tres tablas paginadas (Egresos, Liquidez, Inversiones). */
export const PAGE_SIZE = 25;

export type UploadBtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BTN_BASE =
  'inline-flex h-9 shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-ui-md px-3 text-[13px] font-medium disabled:pointer-events-none disabled:opacity-50 [@media(pointer:coarse)]:h-10';

const BTN_VARIANT: Record<UploadBtnVariant, string> = {
  // Primario: UNO por pantalla — «Guardar ahora» de la barra inferior.
  primary:
    'border border-primary bg-primary text-brand-on-primary hover:bg-[color-mix(in_srgb,var(--color-primary)_86%,black)]',
  secondary: 'border border-border-strong bg-card text-foreground hover:bg-surface-2',
  ghost: 'text-text-2 hover:bg-surface-2 hover:text-foreground',
  danger: 'border border-neg/35 bg-neg-bg text-neg hover:border-neg',
};

export function btnClass(variant: UploadBtnVariant = 'secondary', className?: string): string {
  return cn(BTN_BASE, BTN_VARIANT[variant], className);
}

/** Botón-ícono de fila (32×32, 40 en táctil). Gris: el ícono y el aria-label dicen qué hace. */
export const ROW_BTN =
  'inline-flex size-8 items-center justify-center rounded-ui-md text-text-2 hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:size-10';

/** Borrar: el rojo aparece al apuntar (es destructivo), no en reposo. */
export const ROW_BTN_DANGER = cn(ROW_BTN, 'hover:bg-neg-bg hover:text-neg');

/** Extra para `<Input>` de la primitiva: 16 px en móvil (zoom de iOS) y cifras alineadas. */
export const INPUT_MOBILE = 'max-sm:text-base';
export const INPUT_NUM = cn(INPUT_MOBILE, 'text-right', NUM_CLASS);

// ── Tabla editable (Egresos) ─────────────────────────────────────────────
// Egresos no puede usar <FinTable>: cada <tr> lo crea `useSortable` (dnd-kit
// necesita el ref del <tr>) y la fila en edición reemplaza todas sus celdas.
// Estas clases copian la receta de escritorio de FinTable (§5.3) para que se
// vea igual que las otras pestañas.
export const TABLE = 'w-full border-separate border-spacing-0 text-[13px]';
export const TH =
  'h-[34px] whitespace-nowrap border-b border-border-strong bg-card px-3 first:pl-4 last:pr-4 text-[11.5px] font-semibold uppercase tracking-[.03em] text-text-3';
export const TD = 'h-row border-b border-border px-3 py-1.5 align-middle first:pl-4 last:pr-4';
export const TFOOT_TD =
  'h-[42px] bg-card px-3 font-[650] text-foreground shadow-[inset_0_1.5px_0_0_var(--foreground)] first:pl-4 last:pr-4';

/** Lista de sugerencias de un autocompletado (concepto / categoría de egresos). */
export const SUGGEST_LIST =
  'absolute left-0 right-0 top-full mt-1 overflow-auto rounded-ui-md border border-border bg-card shadow-2';
export const SUGGEST_ITEM = 'w-full px-3 py-2 text-left text-[13px] text-foreground hover:bg-surface-2';

// ── Paginación ───────────────────────────────────────────────────────────

export function PaginationControls({
  page,
  totalPages,
  totalItems,
  onChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  onChange: (next: number) => void;
}) {
  const { t } = useI18n();
  // Oculta con 25 filas o menos: la spec de la pantalla es «una sola página».
  if (totalItems <= PAGE_SIZE) return null;
  const from = page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, totalItems);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
      {/* La página recorta las filas, no los totales: dicho con números
          (reglas §1.2 — un recorte silencioso es indistinguible de «no hay más»). */}
      <span className={cn(NUM_CLASS, 'text-text-3')}>
        {t('upload.pageRange', { from: String(from), to: String(to), total: String(totalItems) })}
        {' · '}
        {t('upload.ledger.pageTotals', { total: String(totalItems) })}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(Math.max(0, page - 1))}
          disabled={page === 0}
          className={ROW_BTN}
          aria-label={t('upload.prevPage')}
        >
          <ChevronLeft aria-hidden className="size-4" />
        </button>
        <span className={cn(NUM_CLASS, 'px-2 text-text-2')}>
          {t('upload.pageOf', { page: String(page + 1), total: String(totalPages) })}
        </span>
        <button
          type="button"
          onClick={() => onChange(Math.min(totalPages - 1, page + 1))}
          disabled={page >= totalPages - 1}
          className={ROW_BTN}
          aria-label={t('upload.nextPage')}
        >
          <ChevronRight aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}

// ── «Guardado hace Xs» ───────────────────────────────────────────────────

/** Se re-renderiza cada 10 s sola, así el padre no tiene que ser dueño de un
 *  reloj. Se apaga a los 5 min: para entonces el usuario ya siguió. */
export function SavedRecentlyBadge({ at }: { at: Date }) {
  const { t } = useI18n();
  // secs se calcula DENTRO del effect (no en render): la regla react-compiler
  // prohíbe llamar funciones impuras como Date.now() durante el render.
  // `atMs` es estable (getTime es puro), así el effect corre una sola vez.
  const atMs = at.getTime();
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const update = () => setSecs(Math.floor((Date.now() - atMs) / 1000));
    update();
    const id = setInterval(update, 10_000);
    return () => clearInterval(id);
  }, [atMs]);
  if (secs > 300) return null;
  const label =
    secs < 5
      ? t('common.saved')
      : secs < 60
        ? t('upload.savedSecondsAgo', { secs: String(secs) })
        : t('upload.savedMinutesAgo', { mins: String(Math.floor(secs / 60)) });
  return <SaveDot tone="pos" label={label} title={t('upload.lastSavedTitle')} />;
}

/** Punto + texto del estado de guardado (pos = guardado, pend = sin guardar, info = guardando). */
export function SaveDot({
  tone,
  label,
  title,
  pulse,
}: {
  tone: 'pos' | 'pend' | 'info';
  label: React.ReactNode;
  title?: string;
  pulse?: boolean;
}) {
  const color = { pos: 'text-pos', pend: 'text-pend', info: 'text-info' }[tone];
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium', color)}
      aria-live="polite"
      title={title}
      data-tone={tone}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full bg-current', pulse && 'animate-pulse motion-reduce:animate-none')} />
      {label}
    </span>
  );
}

// ── Campo de monto suelto (Ventas Prop Firm, P2P) ────────────────────────

/**
 * Un monto que se carga aparte de la tabla y NO suma a su total. El aviso
 * («no suma al total de depósitos») va como hint del campo, no en gris suelto
 * debajo de un label sin `for`, para que el lector de pantalla lo lea con el
 * control.
 */
export function SideAmountField({
  label,
  hint,
  crmHint,
  editable,
  value,
  disabled,
  onChange,
}: {
  label: React.ReactNode;
  hint: React.ReactNode;
  /** Lo que el CRM tiene para el período. null = no hay pista (no es 0). */
  crmHint?: number | null;
  editable: boolean;
  value: number;
  disabled?: boolean;
  /** Recibe el texto crudo del input; el padre decide cómo parsearlo. */
  onChange: (raw: string) => void;
}) {
  const { t } = useI18n();
  const hintNode = (
    <>
      {hint}
      {crmHint != null && (
        <>
          {' · '}
          {t('upload.crmHint')}: <Money value={crmHint} />
        </>
      )}
    </>
  );
  if (!editable) {
    return (
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground">{label}</p>
          <p className="text-[12px] text-text-3">{hintNode}</p>
        </div>
        <Money value={value} className="font-medium" />
      </div>
    );
  }
  return (
    <Field label={label} hint={hintNode} className="sm:max-w-xs">
      <Input
        type="number"
        step="0.01"
        value={value || ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT_NUM}
        placeholder="0.00"
      />
    </Field>
  );
}

// ── Badges de la pantalla ────────────────────────────────────────────────

/** «Cerrado» en la cabecera de cada panel: neutro (spec §5.5 — Cerrado, Borrador). */
export function ClosedBadge() {
  const { t } = useI18n();
  return <StatusBadge kind="neutral" label={t('upload.ledger.closed')} title={t('upload.ledger.closedBadgeTitle')} />;
}

/**
 * Fuente del número: «Auto» (lo trajo una API / el espejo del CRM) en `info`
 * — la spec reserva `info` para «fuente automática» (§2.1) —, «Manual» en
 * neutro. Antes «auto» iba en `text-positive` 10 px: verde de «ganancia» sobre
 * algo que no es ni bueno ni malo.
 */
export function SourceBadge({ source, title }: { source: 'auto' | 'manual'; title?: string }) {
  const { t } = useI18n();
  return source === 'auto' ? (
    <StatusBadge kind="info" label={t('upload.ledger.auto')} title={title} />
  ) : (
    <StatusBadge kind="neutral" label={t('upload.ledger.manual')} title={title} />
  );
}
