'use client';

import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// Button — primitiva única de botones (rediseño UX 2026-07).
//
// Antes: 387 <button> inline con estilos que derivaban (2 escalas de rojo para
// destructivo, 3 paddings de primario, disabled inconsistente, 3 idiomas de
// spinner). Esta primitiva fija variante × tamaño × estados una sola vez.
//
// Variantes:
//   primary     acción principal de la vista (máx. 1 por zona)
//   secondary   acciones normales (export, abrir modal, …) — el default
//   ghost       acciones terciarias / dentro de tablas
//   destructive borrar / acciones irreversibles
//   icon        botón de solo icono — EXIGE aria-label (TS lo fuerza)
//
// Estados: hover / active (press) / focus-visible (regla global en
// globals.css) / disabled / loading (spinner + disabled automático).
//
// Colores a tokens (2026-10-12, barrido final «Libro mayor»): el primario era
// `text-white` fijo sobre `--color-primary` (ilegible con una marca clara) y
// el destructivo `bg-negative text-white` (en oscuro, blanco sobre #F87171 =
// 2,8:1). Ahora usan las MISMAS recetas que `ui/action-button.tsx`: primario
// con `text-brand-on-primary`, destructivo `neg` sobre `neg-bg`. Se queda
// con sus medidas (36 px, `rounded-lg`): lo usan 8 pantallas y reemplazarlo
// por ActionButton (32 px, otra API de tamaños) movería su layout.
// Descartado: re-exportar ActionButton con este nombre — `destructive` vs
// `danger` y `size` no existen allá; sería romper 8 llamadas por un rename.
// ─────────────────────────────────────────────────────────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type Size = 'sm' | 'md' | 'icon';

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-primary text-brand-on-primary hover:bg-[color-mix(in_srgb,var(--color-primary)_88%,#000)] active:bg-[color-mix(in_srgb,var(--color-primary)_78%,#000)]',
  secondary:
    'border border-border-strong bg-card text-foreground hover:bg-surface-2 active:bg-surface-2/70',
  ghost:
    'text-text-2 hover:bg-surface-2 hover:text-foreground active:bg-surface-2/70',
  destructive:
    'border border-neg/35 bg-neg-bg text-neg hover:border-neg',
};

const SIZE: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  icon: 'h-9 w-9 p-0',
};

interface BaseProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Muestra spinner y deshabilita. El label queda visible (no salta el ancho). */
  loading?: boolean;
}

/* Un botón de solo icono sin nombre accesible se anuncia como "botón" a secas.
   Con esta unión, size="icon" no compila sin aria-label. */
type ButtonProps =
  | (BaseProps & { size?: Exclude<Size, 'icon'> })
  | (BaseProps & { size: 'icon'; 'aria-label': string });

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'secondary', size = 'md', loading, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          'inline-flex items-center justify-center rounded-lg font-medium select-none',
          'transition-colors duration-[var(--duration-fast)]',
          'disabled:opacity-50 disabled:pointer-events-none',
          VARIANT[variant],
          SIZE[size],
          className,
        )}
        {...props}
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden />}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';
