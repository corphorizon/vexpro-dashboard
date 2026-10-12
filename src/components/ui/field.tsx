'use client';

import { createContext, forwardRef, useContext, useId } from 'react';
import { AlertCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// Field + Input / Select / Textarea — controles de formulario «Libro mayor»
// (spec §5.6).
//
// POR QUÉ (2026-10-12):
//   · Borde: los inputs usan `border-border` (#E2E8F0; 67 `<input` en src/app
//     con `border border-border`), 1,2:1 contra blanco — el control casi no
//     se ve. WCAG 1.4.11 pide 3:1 para el borde de un
//     componente; `control-border` da 3,07 (claro) / 3,33 (oscuro), medido en
//     design-tokens.test.ts.
//   · Label: varios formularios usan sólo `placeholder` como etiqueta; al
//     escribir desaparece y el lector de pantalla no la anuncia. Acá el label
//     es obligatorio (prop requerida) y siempre visible, atado por `htmlFor`.
//   · Error: no sólo color — ícono + texto debajo, `aria-invalid` y
//     `aria-describedby` al mensaje, borde `neg`.
//   · Foco: UNA receta, la global de globals.css (`:focus-visible`, 2 px
//     `--accent`). Estos controles NO agregan `focus:ring-*` propio: medido en
//     src/, conviven `focus:ring-accent` (48), `focus:ring-accent/30` (6),
//     `focus:ring-primary/50` (4), `focus:border-primary` (2), `ring-red-*`
//     y el global, casi siempre con `focus:outline-none` (144). Una receta
//     más sería otra divergencia.
//
// Alto 36 px (pedido de la tanda; la spec §5.6 dice 32 — ver el reporte): con
// 36 el control coincide con `h-row` y la fila de un formulario en línea
// alinea con la de la tabla.
//
// Cómo se cablea: <Field> crea un id con useId y lo pasa por contexto; el
// <Input>/<Select>/<Textarea> hijo lo toma solo. Fuera de un Field funcionan
// igual (sin label: entonces exigí `aria-label` vos).
//
// DESCARTADO: cambiar los inputs existentes (decenas de formularios, fase 5).
// ─────────────────────────────────────────────────────────────────────────────

interface FieldCtx {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required?: boolean;
}

const FieldContext = createContext<FieldCtx | null>(null);

export interface FieldProps {
  label: React.ReactNode;
  hint?: React.ReactNode;
  /** Mensaje de error. Si está, el control queda `aria-invalid` con borde `neg`. */
  error?: React.ReactNode;
  required?: boolean;
  /** id explícito del control (si no, se genera). */
  id?: string;
  className?: string;
  children: React.ReactNode;
}

export function Field({ label, hint, error, required, id: idProp, className, children }: FieldProps) {
  const { t } = useI18n();
  const autoId = useId();
  const id = idProp ?? `f${autoId.replace(/:/g, '')}`;
  const hintId = hint != null ? `${id}-hint` : undefined;
  const errorId = error != null ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: error != null, required }}>
      <div className={cn('flex flex-col gap-1', className)}>
        <label htmlFor={id} className="text-[12.5px] font-medium text-text-2">
          {label}
          {required && (
            <span className="text-neg">
              {' *'}
              <span className="sr-only"> ({t('ui.field.required')})</span>
            </span>
          )}
        </label>
        {children}
        {error != null ? (
          <p id={errorId} className="flex items-start gap-1 text-[12px] leading-4 text-neg">
            <AlertCircle aria-hidden className="mt-px size-3.5 shrink-0" strokeWidth={2} />
            <span>{error}</span>
          </p>
        ) : null}
        {hint != null && (
          <p id={hintId} className="text-[12px] leading-4 text-text-3">
            {hint}
          </p>
        )}
      </div>
    </FieldContext.Provider>
  );
}

/** Clases comunes de control. Exportadas para controles a medida (combobox, etc.). */
export const CONTROL_CLASS =
  'w-full rounded-ui-md border bg-card px-2.5 text-[13px] text-foreground placeholder:text-text-3 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-3';

function useControlProps<T extends { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: React.AriaAttributes['aria-invalid']; required?: boolean }>(props: T) {
  const ctx = useContext(FieldContext);
  const invalid = props['aria-invalid'] ?? (ctx?.invalid || undefined);
  return {
    id: props.id ?? ctx?.id,
    'aria-describedby': props['aria-describedby'] ?? ctx?.describedBy,
    'aria-invalid': invalid,
    required: props.required ?? ctx?.required,
    borderClass: invalid && invalid !== 'false' ? 'border-neg' : 'border-control-border',
  };
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /**
   * 32 px en vez de 36: el input DENTRO de una fila de tabla (spec §5.6, alto
   * 32). Agregado 2026-10-12 para las celdas editables de /comisiones: `cn` es
   * clsx sin tailwind-merge, así que un `h-8` del llamador no pisa el `h-9` de
   * forma fiable — el alto tiene que decidirse acá.
   */
  compact?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input({ className, compact, ...props }, ref) {
    const { borderClass, ...wired } = useControlProps(props);
    return (
      <input ref={ref} {...props} {...wired} className={cn(CONTROL_CLASS, compact ? 'h-8' : 'h-9', borderClass, className)} />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    const { borderClass, ...wired } = useControlProps(props);
    return (
      <select ref={ref} {...props} {...wired} className={cn(CONTROL_CLASS, 'h-9 pr-8', borderClass, className)}>
        {children}
      </select>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 3, ...props }, ref) {
    const { borderClass, ...wired } = useControlProps(props);
    return (
      <textarea
        ref={ref}
        rows={rows}
        {...props}
        {...wired}
        className={cn(CONTROL_CLASS, 'min-h-[72px] py-2 leading-5', borderClass, className)}
      />
    );
  },
);
