'use client';

import { forwardRef, useState } from 'react';
import { Check, Circle, Eye, EyeOff, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/field';
import { useI18n } from '@/lib/i18n';
import { OTP_LENGTH, PASSWORD_MIN_LENGTH, sanitizeOtp, type PasswordRequirement } from '@/lib/auth-form';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// Controles de las pantallas de acceso («Libro mayor», 2026-10-12).
//
// POR QUÉ:
//   · Medido antes del cambio en login, reset-password, reset-2fa, setup-2fa y
//     el modal de PIN: 11 inputs con `border-border` (1,2:1 contra blanco, el
//     control casi no se ve) y `focus:ring-[var(--color-secondary)]` propio;
//     9 botones primarios `bg-[var(--color-primary)] text-white` (blanco fijo:
//     con una marca pastel el texto no se lee — el token es
//     `text-brand-on-primary`); 4 implementaciones de «mostrar contraseña», sólo
//     una con `aria-pressed`. Acá hay UNA de cada cosa, armada sobre
//     `Field/Input` (borde `control-border` 3:1, foco global, error con
//     `aria-invalid`).
//   · Alto 40 px (no los 36 del `Input` de tablas): son pantallas que se usan
//     con el pulgar; el pedido fija ≥ 40 de objetivo táctil. Se fuerza con `!`
//     porque `cn` es clsx sin tailwind-merge — dos `h-*` juntos los ordena el
//     CSS, no el className.
//   · `max-sm:text-[16px]!`: iOS hace zoom al enfocar un input de menos de
//     16 px; en un login a 390 px eso descoloca la pantalla entera.
//
// DESCARTADO:
//   · Seis casillas para el código: rompen el pegado desde el gestor de
//     contraseñas y `autocomplete="one-time-code"` sólo autocompleta UN input.
//     Un input con `inputmode="numeric"`, tipografía tabular grande y
//     espaciado amplio se lee igual de bien y no pierde nada.
//   · Usar `<Button variant="primary">` de components/ui: es 36 px, `rounded-lg`
//     y `text-white` fijo. Cambiarlo afecta toda la app (otro agente / fase 4).
// ─────────────────────────────────────────────────────────────────────────────

/** Primario de 40 px SIN ancho (para centrar un botón suelto: arranque, 404). */
export const AUTH_PRIMARY_BASE_CLASS =
  'inline-flex h-10 items-center justify-center gap-2 rounded-ui-md bg-primary px-4 text-[13.5px] font-medium text-brand-on-primary transition-colors hover:bg-[color-mix(in_srgb,var(--color-primary)_86%,black)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none';

/** Botón/enlace primario de una pantalla de acceso: 40 px, ancho completo. */
export const AUTH_PRIMARY_CLASS = `${AUTH_PRIMARY_BASE_CLASS} w-full`;

/** Secundario: borde `border-strong`, superficie, hover `surface-2`. */
export const AUTH_SECONDARY_CLASS =
  'inline-flex h-10 items-center justify-center gap-2 rounded-ui-md border border-border-strong bg-card px-4 text-[13px] font-medium text-foreground transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none';

/** Acción de texto («¿Olvidaste tu contraseña?», «Volver»): 40 px de alto táctil. */
export const AUTH_LINK_CLASS =
  'inline-flex min-h-10 items-center gap-1.5 rounded-ui-sm text-[13px] font-medium text-brand-ink underline-offset-4 hover:underline';

/** Acción de texto secundaria (gris). */
export const AUTH_QUIET_LINK_CLASS =
  'inline-flex min-h-10 items-center gap-1.5 rounded-ui-sm text-[13px] text-text-2 underline-offset-4 hover:text-foreground hover:underline';

const AUTH_INPUT_CLASS = 'h-10! max-sm:text-[16px]!';

interface SubmitProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  loading?: boolean;
  /** Texto mientras carga («Ingresando…»). El botón sigue diciendo qué hace. */
  loadingLabel: string;
  children: React.ReactNode;
}

/** Botón primario con estado de carga: spinner + texto, deshabilitado, `aria-busy`. */
export function AuthSubmit({ loading, loadingLabel, disabled, className, children, type = 'submit', ...rest }: SubmitProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(AUTH_PRIMARY_CLASS, className)}
      {...rest}
    >
      {loading ? (
        <>
          <Loader2 aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
          {loadingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** Input de texto/email de 40 px dentro de un `<Field>`. */
export const AuthInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function AuthInput({ className, ...props }, ref) {
    return <Input ref={ref} {...props} className={cn(AUTH_INPUT_CLASS, className)} />;
  },
);

interface PasswordInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Visibilidad controlada desde afuera (p. ej. compartida con «Confirmar»). */
  visible?: boolean;
  onVisibleChange?: (v: boolean) => void;
  /** Sin botón propio (cuando otro campo ya lo tiene). */
  hideToggle?: boolean;
}

/** Contraseña con mostrar/ocultar (botón de 40×40, `aria-pressed`). */
export function PasswordInput({ visible, onVisibleChange, hideToggle, className, ...props }: PasswordInputProps) {
  const { t } = useI18n();
  const [own, setOwn] = useState(false);
  const shown = visible ?? own;
  const toggle = () => (onVisibleChange ? onVisibleChange(!shown) : setOwn(!shown));
  return (
    <div className="relative">
      <Input
        {...props}
        type={shown ? 'text' : 'password'}
        className={cn(AUTH_INPUT_CLASS, !hideToggle && 'pr-11', className)}
      />
      {!hideToggle && (
        <button
          type="button"
          onClick={toggle}
          aria-label={shown ? t('auth.hidePassword') : t('auth.showPassword')}
          aria-pressed={shown}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-ui-md text-text-2 hover:text-foreground"
        >
          {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
        </button>
      )}
    </div>
  );
}

interface OtpInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: string;
  onChange: (digits: string) => void;
}

/**
 * Código de 6 dígitos: `inputmode="numeric"`, `autocomplete="one-time-code"`
 * (iOS/Android ofrecen el código del SMS/email), 24 px tabular, espaciado
 * ancho. Sanea a dígitos al escribir o pegar.
 */
export function OtpInput({ value, onChange, className, ...props }: OtpInputProps) {
  return (
    <Input
      type="text"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern={`[0-9]{${OTP_LENGTH}}`}
      maxLength={OTP_LENGTH}
      placeholder={'0'.repeat(OTP_LENGTH)}
      {...props}
      value={value}
      onChange={(e) => onChange(sanitizeOtp(e.target.value))}
      className={cn(
        'h-12! text-center text-[24px]! font-semibold tracking-[0.4em] tabular-nums slashed-zero',
        className,
      )}
    />
  );
}

/**
 * Lista de requisitos de contraseña: check `pos` cumplido / círculo `text-3`
 * pendiente. El estado también va en texto para lectores de pantalla (no sólo
 * color ni sólo ícono). `aria-live="polite"`: anuncia cuando un requisito pasa
 * a cumplido sin interrumpir lo que se escribe.
 */
export function PasswordRequirements({ items, id }: { items: PasswordRequirement[]; id?: string }) {
  const { t } = useI18n();
  const label = (r: PasswordRequirement) =>
    r.id === 'minLength' ? t('auth.pw.minLength', { min: String(PASSWORD_MIN_LENGTH) }) : t('auth.pw.match');
  return (
    <ul id={id} aria-live="polite" className="space-y-1 text-[12.5px] leading-5">
      {items.map((r) => (
        <li
          key={r.id}
          data-met={r.met}
          className={cn('flex items-center gap-2', r.met ? 'text-pos' : 'text-text-3')}
        >
          {r.met ? (
            <Check aria-hidden className="size-3.5 shrink-0" strokeWidth={2.5} />
          ) : (
            <Circle aria-hidden className="size-3.5 shrink-0" strokeWidth={2} />
          )}
          <span>{label(r)}</span>
          <span className="sr-only">({r.met ? t('auth.pw.met') : t('auth.pw.pending')})</span>
        </li>
      ))}
    </ul>
  );
}
