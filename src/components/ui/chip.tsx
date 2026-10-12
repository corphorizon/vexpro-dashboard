'use client';

import { forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { NUM_CLASS } from './money';

// ─────────────────────────────────────────────────────────────────────────────
// Chip — chip de filtro («Libro mayor», spec §5.6).
//
// POR QUÉ (2026-10-12): un filtro que se puede agregar tiene que verse
// DISTINTO de uno aplicado sin depender sólo del color. La spec lo resuelve
// con la forma del borde: inactivo = borde 1 PUNTEADO `border-strong` («esto
// se puede sumar»); activo = borde SÓLIDO `brand-ink`, fondo `brand-tint`,
// 600. Se lee igual en escala de grises.
//
// Es un toggle: `aria-pressed` refleja `active`. Alto 28, `rounded-full`.
// En puntero grueso (táctil) el área de toque se agranda a 40 px con un
// pseudo-elemento, sin cambiar el alto visible.
//
// DESCARTADO: un botón «×» dentro del chip para quitarlo — dos controles en
// una píldora de 28 px no llegan al área táctil; se quita volviendo a tocar.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChipProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-pressed'> {
  active?: boolean;
  /** Conteo opcional. null/undefined no se muestra (no es 0). */
  count?: number | null;
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { active = false, count, icon: Icon, className, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={active}
      {...props}
      className={cn(
        'relative inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[12.5px]',
        "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-y-1.5 [@media(pointer:coarse)]:after:inset-x-0 [@media(pointer:coarse)]:after:content-['']",
        'disabled:cursor-not-allowed disabled:opacity-50',
        active
          ? 'border-solid border-brand-ink bg-brand-tint font-semibold text-brand-ink'
          : 'border-dashed border-border-strong bg-card font-medium text-text-2 hover:border-brand-ink hover:text-brand-ink',
        className,
      )}
    >
      {Icon && <Icon aria-hidden className="size-3.5 shrink-0" />}
      {children}
      {typeof count === 'number' && Number.isFinite(count) && (
        <span className={cn(NUM_CLASS, active ? 'text-brand-ink' : 'text-text-3')}>{count}</span>
      )}
    </button>
  );
});
