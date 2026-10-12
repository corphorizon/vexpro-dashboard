'use client';

import { cn } from '@/lib/utils';
import { NUM_CLASS } from './money';

// ─────────────────────────────────────────────────────────────────────────────
// Segmented — control segmentado («Libro mayor», spec §5.6 `seg`).
//
// POR QUÉ (2026-10-12): los selectores de vista se arman a mano como filas
// de botones con el activo en `bg-primary text-white` (así en RRHH, CRM,
// Asistente y Riesgo/retiros, entre otros): un relleno de marca por cada
// filtro, compitiendo con el único botón primario de la pantalla (spec §5.1:
// uno por pantalla). Acá el activo
// es superficie + `shadow-1` + 600 sobre un carril `surface-2`: se distingue
// por forma y peso, no por color.
//
// A11y: grupo con `aria-label` y botones con `aria-pressed` (lo pide la
// spec). Cada botón es tabulable: con 2-4 opciones no hace falta el patrón de
// flechas de un radiogroup, y `aria-pressed` lo anuncia bien.
//
// Medidas: botones 26 de alto, 12.5/500 `text-2`, carril con borde y
// padding 2. Conteo opcional en `text-3`.
//
// Color de marca (2026-10-12, spec §10): el activo sigue siendo superficie +
// sombra + 600 (forma y peso), y además su texto va en `brand-ink` con un
// filete inferior de marca — la selección es estructura, no dato.
//
// DESCARTADO: role="radiogroup"/"radio" — exige manejar flechas y roving
// tabindex; la spec eligió `aria-pressed`.
// ─────────────────────────────────────────────────────────────────────────────

export interface SegmentedOption<V extends string> {
  value: V;
  label: React.ReactNode;
  /** Conteo opcional («Pendientes 4»). null = no se sabe → no se muestra un 0. */
  count?: number | null;
  disabled?: boolean;
}

export interface SegmentedProps<V extends string> {
  options: SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Obligatorio: el grupo necesita nombre para el lector de pantalla. */
  'aria-label': string;
  className?: string;
}

export function Segmented<V extends string>({
  options,
  value,
  onChange,
  className,
  ...aria
}: SegmentedProps<V>) {
  return (
    <div
      role="group"
      aria-label={aria['aria-label']}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-ui-md border border-border bg-surface-2 p-0.5',
        className,
      )}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-ui-sm px-2.5 text-[12.5px] disabled:cursor-not-allowed disabled:opacity-50',
              active
                ? 'bg-card font-semibold text-brand-ink shadow-[inset_0_-2px_0_0_var(--brand-ink),var(--shadow-1)]'
                : 'font-medium text-text-2 hover:text-foreground',
            )}
          >
            {o.label}
            {typeof o.count === 'number' && Number.isFinite(o.count) && (
              <span className={cn(NUM_CLASS, 'font-medium text-text-3')}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
