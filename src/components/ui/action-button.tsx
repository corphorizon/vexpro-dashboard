'use client';

import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// ActionButton — la primitiva de botones con la receta «Libro mayor»
// (docs/diseno-libro-mayor.md §5.1).
//
// MUDADA el 2026-10-12 (barrido final) de `components/payment-orders/` a
// `components/ui/`: medido, 56 archivos de Riesgo, RRHH, Superadmin,
// Liquidez, Perfil… la importaban desde Órdenes de pago. La ruta vieja queda
// como re-export. Nació en Órdenes de pago; la historia sigue abajo.
//
// POR QUÉ (2026-10-12): el `Button` legado (ui/button.tsx) pinta el primario
// `bg-[var(--color-primary)] text-white` — blanco fijo, que con una marca clara
// (brand-color.ts calcula `--brand-on-primary` justamente para eso) deja texto
// blanco sobre fondo claro — y el destructivo en `bg-negative text-white`, que
// en oscuro cae sobre el rojo claro #F97066 a menos de 3:1. Además mide 36 px y
// `rounded-lg`, no los 32 px / `rounded-ui-md` de la spec. Balances y
// Movimientos ya resolvieron esto con strings locales (`BTN`, `secondaryBtn`);
// acá son tres pantallas (listado, detalle, formulario) y un diálogo, así que
// la receta vive UNA vez para el módulo, con `loading` como el legado.
//
//   primary     brand + `text-brand-on-primary`. UNO por pantalla/estado.
//   secondary   superficie + borde `border-strong`.
//   ghost       sin borde, `text-text-2`.
//   danger      `neg` sobre `neg-bg` con borde `neg` al 35 %: dice «peligro»
//               con el token que flipa solo, sin texto blanco sobre rojo.
//
// Táctil: alto 40 con `pointer: coarse` (mismo criterio que Balances).
//
// DESCARTADO:
//   · Cambiar `ui/button.tsx`: lo usan decenas de pantallas que no migraron;
//     su primario pasa a `text-brand-on-primary` cuando la fase 5 llegue a
//     todas. Este archivo es el candidato a reemplazarlo (mismo API).
//     [2026-10-12, barrido final] Hecho a medias: `ui/button.tsx` ya pinta
//     con tokens (mismo primario y mismo `danger` que acá) y conserva sus
//     medidas (36 px, `rounded-lg`) para no mover el layout de las 8
//     pantallas que todavía lo usan.
//   · Un `variant="icon"`: los botones-ícono de fila son `ROW_ACTION_CLASS`
//     (32×32 sin borde, como el ROW_BTN de Balances).
// ─────────────────────────────────────────────────────────────────────────────

export type ActionVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BASE =
  'inline-flex h-8 shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-ui-md px-3 text-[13px] font-medium disabled:pointer-events-none disabled:opacity-50 [@media(pointer:coarse)]:h-10';

const VARIANT: Record<ActionVariant, string> = {
  primary:
    'border border-primary bg-primary text-brand-on-primary hover:bg-[color-mix(in_srgb,var(--color-primary)_86%,black)]',
  secondary: 'border border-border-strong bg-card text-foreground hover:bg-surface-hover',
  ghost: 'text-text-2 hover:bg-surface-hover hover:text-foreground',
  danger: 'border border-neg/35 bg-neg-bg text-neg hover:border-neg',
};

/** Clases para un <Link> que se ve como botón (no se puede anidar <button> en <a>). */
export function actionButtonClass(variant: ActionVariant = 'secondary', className?: string): string {
  return cn(BASE, VARIANT[variant], className);
}

/** Botón-ícono de fila / de lista (32×32, 40 en táctil). Siempre con aria-label. */
export const ROW_ACTION_CLASS =
  'inline-flex size-8 items-center justify-center rounded-ui-md text-text-2 hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:size-10';

export interface ActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ActionVariant;
  /** Spinner + deshabilitado; el texto queda (el ancho no salta). */
  loading?: boolean;
}

export const ActionButton = forwardRef<HTMLButtonElement, ActionButtonProps>(function ActionButton(
  { variant = 'secondary', loading, disabled, className, children, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={actionButtonClass(variant, className)}
      {...props}
    >
      {loading && <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />}
      {children}
    </button>
  );
});
