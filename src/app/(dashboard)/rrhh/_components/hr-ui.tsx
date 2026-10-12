'use client';

import { useEffect, useId } from 'react';
import { ChevronDown, ChevronRight, Search, Upload, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/field';
import { Money, type MoneyTone } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { ROW_ACTION_CLASS } from '@/components/ui/action-button';
import type { NetDepositSource } from '@/lib/hr/net-deposit-input';
import { NET_SOURCE_VIEW } from './hr-view';

// ─────────────────────────────────────────────────────────────────────────────
// hr-ui — piezas de pantalla que RRHH repetía en cada pestaña («Libro mayor»,
// 2026-10-12).
//
// POR QUÉ: medido antes de la migración en rrhh/** — 7 modales armados a mano
// (`fixed inset-0 bg-black/50` + `rounded-xl shadow-xl`, cada uno con su
// cabecera y su ✕), 5 buscadores con el ícono posicionado a mano, 3 «subir
// contrato» con `border-dashed` y `hover:border-[var(--color-secondary)]`, y
// el rótulo de procedencia del net (CRM/manual/cerrado/sin datos) escrito dos
// veces en `text-[10px]` con verde de paleta. Se juntan acá para que la
// migración sea UNA receta y no siete parecidas.
//
// Medidas: modal `rounded-ui-xl` + `shadow-3` + scrim negro al 45 % (spec
// §6.1, drawer); cabecera como la de Panel (h2 15/600); pie con las acciones a
// la derecha. Rótulo de fuente = spec §5.5 `.src` (10.5/600 MAYÚSCULAS, borde
// `border-strong`, `rounded-ui-sm`; CRM en `info` porque es la fuente
// automática); «sin datos» es un StatusBadge `stale`.
//
// DESCARTADO:
//   · Un `Modal` en src/components/ui/: la tanda tiene ese directorio vedado.
//     Si otra pantalla lo quiere, esto se mueve tal cual (no depende de RRHH).
//   · `role="dialog"` con trampa de foco completa: los modales legados no la
//     tenían y agregarla es comportamiento, no presentación. Sí se agrega
//     `aria-modal`, `aria-labelledby` y Escape para cerrar.
// ─────────────────────────────────────────────────────────────────────────────

/** Checkbox con el color de marca (no `--color-primary` legado). */
export const CHECKBOX_CLASS = 'size-4 shrink-0 cursor-pointer rounded-ui-sm accent-brand-ink';

/** Botón-ícono de fila (32×32, 40 táctil) — el de Órdenes de pago. */
export { ROW_ACTION_CLASS };

/**
 * El mismo botón-ícono para acciones destructivas (borrar): hover en `neg`.
 * Es una receta aparte y no `cn(ROW_ACTION_CLASS, 'hover:text-neg')` porque
 * `cn` es clsx sin tailwind-merge: dos `hover:text-*` pelean por orden de CSS.
 */
export const ROW_DANGER_CLASS = ROW_ACTION_CLASS.replace('hover:text-foreground', 'hover:text-neg');

/** Colapsar/expandir dentro de una fila: 24 px (36 táctil), sin pelear con ROW_ACTION_CLASS. */
export const TOGGLE_CLASS =
  'inline-flex size-6 shrink-0 items-center justify-center rounded-ui-sm text-text-2 hover:bg-surface-hover hover:text-foreground [@media(pointer:coarse)]:size-9';

export function HrModal({
  title,
  hint,
  onClose,
  children,
  footer,
  size = 'md',
  onSubmit,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Si está, el cuerpo es un <form> (Enter envía) y el pie va adentro. */
  onSubmit?: (e: React.FormEvent) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const width = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-2xl' : 'max-w-lg';
  const body = (
    <>
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-3.5">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[15px] font-semibold leading-5 tracking-[-0.005em] text-foreground">
            {title}
          </h2>
          {hint != null && <p className="mt-0.5 text-[12.5px] leading-4 text-text-3">{hint}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className={ROW_ACTION_CLASS}>
          <X aria-hidden className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {footer != null && (
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer>
      )}
    </>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.45)] p-4"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'flex max-h-[90vh] w-full flex-col overflow-hidden rounded-ui-xl border border-border bg-card shadow-3',
          width,
        )}
      >
        {onSubmit ? (
          <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
            {body}
          </form>
        ) : (
          body
        )}
      </div>
    </div>
  );
}

/**
 * Opción con checkbox y explicación. Antes cada una traía un fondo de color
 * distinto (warning, info, purple con `dark:`) sin que ninguno significara
 * pendiente/info: era decoración. Ahora todas son superficie `surface-2`.
 */
export function OptionBox({
  id,
  checked,
  onChange,
  title,
  hint,
  className,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start gap-2.5 rounded-ui-md border border-border bg-surface-2 px-3 py-2.5', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={cn(CHECKBOX_CLASS, 'mt-0.5')}
      />
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-[13px] font-medium text-foreground">{title}</span>
        {hint != null && <span className="mt-0.5 block text-[12px] leading-4 text-text-3">{hint}</span>}
      </label>
    </div>
  );
}

/** Selector de archivo (contrato, adjuntos): zona punteada + nombre elegido. */
export function FilePick({
  file,
  onFile,
  placeholder,
  accept = '.pdf,.doc,.docx,.png,.jpg,.jpeg',
}: {
  file: File | null;
  onFile: (f: File | null) => void;
  placeholder: React.ReactNode;
  accept?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2">
      <label className="min-w-0 flex-1 cursor-pointer">
        <span className="flex h-9 items-center gap-2 rounded-ui-md border border-dashed border-border-strong bg-card px-2.5 text-[13px] text-text-2 hover:bg-surface-hover">
          <Upload aria-hidden className="size-4 shrink-0 text-text-3" />
          <span className="truncate">{file ? file.name : placeholder}</span>
        </span>
        <input type="file" accept={accept} className="sr-only" onChange={(e) => onFile(e.target.files?.[0] || null)} />
      </label>
      {file && (
        <button type="button" onClick={() => onFile(null)} aria-label={t('common.cancel')} className={ROW_ACTION_CLASS}>
          <X aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
}

/** Buscador: ícono 15 `text-3` + Input (spec §5.6). */
export function SearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  ariaLabel?: string;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={cn('relative min-w-[220px] max-sm:w-full', className)}>
      <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-[15px] -translate-y-1/2 text-text-3" />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className={cn('pl-8', value && 'pr-9')}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={t('comm.clearSearch')}
          className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-ui-sm text-text-3 hover:text-foreground"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** Rótulo de procedencia del net resuelto: CRM / manual / cerrado; «sin datos» es stale. */
export function SourceTag({ source }: { source: NetDepositSource }) {
  const { t } = useI18n();
  const view = NET_SOURCE_VIEW[source];
  if (view.kind === 'stale') return <StatusBadge kind="stale" label={t(view.labelKey)} />;
  return (
    <span
      className={cn(
        'inline-flex h-[18px] items-center rounded-ui-sm border px-1.5 text-[10.5px] font-semibold uppercase leading-none tracking-[.03em]',
        view.kind === 'info' ? 'border-info/40 text-info' : 'border-border-strong text-text-2',
      )}
    >
      {t(view.labelKey)}
    </span>
  );
}

/** Monto del mes + su procedencia. `null` = «—» con el badge stale; NUNCA $0. */
export function NetWithSource({
  value,
  source,
  tone = 'auto',
  title,
}: {
  value: number | null | undefined;
  source: NetDepositSource;
  tone?: MoneyTone;
  title?: string;
}) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center justify-end gap-1.5" title={title}>
      <Money value={value} tone={tone} nullLabel={t('ui.noData')} className="font-medium" />
      {/* El resolver garantiza value null ⇔ source 'none' (net-deposit-input.ts). */}
      <SourceTag source={source} />
    </span>
  );
}

/** Celda de nombre de un árbol: sangría por nivel + colapsar si tiene hijos. */
export function TreeNameCell({
  name,
  depth,
  hasKids,
  collapsed,
  onToggle,
}: {
  name: string;
  depth: number;
  hasKids: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <span className="flex min-w-0 items-center gap-1" style={{ paddingLeft: depth * 16 }}>
      {hasKids ? (
        <button
          type="button"
          onClick={onToggle}
          className={TOGGLE_CLASS}
          aria-label={collapsed ? t('hr.expandTeam') : t('hr.collapseTeam')}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight aria-hidden className="size-3.5" /> : <ChevronDown aria-hidden className="size-3.5" />}
        </button>
      ) : (
        <span aria-hidden className="w-6 shrink-0" />
      )}
      <span className={cn('truncate', depth === 0 && 'font-semibold')}>{name}</span>
    </span>
  );
}
