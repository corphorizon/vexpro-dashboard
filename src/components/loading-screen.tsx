'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, RotateCw } from 'lucide-react';
import { AuthBrand } from '@/components/auth-brand';
import { AUTH_PRIMARY_BASE_CLASS, AUTH_SECONDARY_CLASS } from '@/components/auth/auth-controls';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// Pantalla de arranque y de error de carga («Libro mayor», 2026-10-12).
//
// La muestra DataProvider (src/lib/data-context.tsx) mientras baja los datos
// iniciales y, si fallan o vencen, `LoadingError`. También puede aparecer en
// navegación de superadmin (sin empresa todavía): por eso el logo es el de
// Smart Dashboard y no el de la empresa.
//
// POR QUÉ:
//   · La barra era un degradado `--color-secondary → --color-primary` de
//     140×3 px sobre un fondo `secondary` al 15 %: dos colores de marca como
//     decoración (spec §2.1: el color es significado). Ahora: pista
//     `surface-sunk`, relleno `accent` (el mismo color del foco), 160×2 px.
//   · Los textos («Está tardando más de lo normal…», «Reintentar ahora») eran
//     español fijo; ahora i18n. El botón era 12 px sin alto mínimo: ahora es el
//     secundario de 40 px.
//   · `role="progressbar"` sin valor: ahora `role="status"` en el contenedor
//     con texto «Cargando» (sr-only si no hay mensaje) — una barra
//     indeterminada no tiene `aria-valuenow` que anunciar.
//   · Sigue el tema: superficie `bg-background`, logo blanco/negro por tema.
//
// La regla de cuándo aparece la pista lenta no cambia: `slowHintAfterMs`
// (LOAD_SLOW_HINT_MS en config.ts, 5 s) y sólo si hay `onRetry` aparece el botón.
//
// DESCARTADO: barra determinada con %. DataProvider no sabe cuántas consultas
// faltan de forma fiable; un porcentaje inventado sería un número plausible y
// falso — justo el tipo de fallo que el repo persigue.
// ─────────────────────────────────────────────────────────────────────────────

interface LoadingScreenProps {
  message?: string;
  /**
   * Optional retry callback. When provided AND the loader has been visible
   * for more than `slowHintAfterMs` (default 5000ms), a "Está tardando…"
   * hint + a "Reintentar ahora" button are rendered below the bar.
   *
   * Without this, a slow Supabase response or a stalled fetch leaves the
   * user staring at the splash with no way out until the DataProvider's
   * 15-second timeout fires.
   */
  onRetry?: () => void;
  /**
   * How long to wait before surfacing the slow hint + retry button.
   * Default: 5000ms (5 seconds). Kevin reported (2026-05-13) that the
   * default 60s timeout felt indistinguishable from a hang.
   */
  slowHintAfterMs?: number;
  /** Forzar la pista lenta (tests / vista de muestra). */
  initialSlow?: boolean;
}

/** Barra fina indeterminada: pista `surface-sunk`, relleno `accent`. */
export function ProgressBar({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('relative h-0.5 w-40 overflow-hidden rounded-full bg-surface-sunk', className)}>
      <div className="absolute inset-y-0 left-0 w-1/2 rounded-full bg-accent animate-[vex-bar-slide_1.4s_ease-in-out_infinite] motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-60" />
    </div>
  );
}

export function LoadingScreen({
  message,
  onRetry,
  slowHintAfterMs = 5000,
  initialSlow = false,
}: LoadingScreenProps) {
  const { t } = useI18n();
  const [slow, setSlow] = useState(initialSlow);

  useEffect(() => {
    const id = setTimeout(() => setSlow(true), slowHintAfterMs);
    return () => clearTimeout(id);
  }, [slowHintAfterMs]);

  return (
    <div className="flex h-full min-h-[60vh] w-full items-center justify-center bg-background px-6 vex-fade-in">
      <div role="status" className="flex max-w-xs flex-col items-center gap-5 text-center">
        <AuthBrand className="size-20" />
        <ProgressBar />
        {message ? (
          <p className="text-[13px] leading-5 text-text-2">{message}</p>
        ) : (
          <span className="sr-only">{t('loading.aria')}</span>
        )}
        {slow && (
          <div className="flex flex-col items-center gap-3">
            <p className="text-[13px] leading-5 text-text-2">{t('loading.slow')}</p>
            {onRetry && (
              <button type="button" onClick={onRetry} className={AUTH_SECONDARY_CLASS}>
                <RotateCw aria-hidden className="size-4" />
                {t('loading.retryNow')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface LoadingErrorProps {
  message: string;
  onRetry: () => void;
}

/**
 * Error de la carga inicial (falló o venció). El mensaje es el que armó
 * DataProvider (qué falló); el título dice que no hay datos — no se muestra
 * el dashboard en cero.
 */
export function LoadingError({ message, onRetry }: LoadingErrorProps) {
  const { t } = useI18n();
  return (
    <div className="flex h-full min-h-[60vh] w-full items-center justify-center bg-background px-6 vex-fade-in">
      <div role="alert" className="flex w-full max-w-sm flex-col items-center gap-5 text-center">
        <AuthBrand className="size-16" />
        <div className="space-y-1">
          <p className="flex items-center justify-center gap-1.5 text-[15px] font-semibold text-neg">
            <AlertCircle aria-hidden className="size-4 shrink-0" />
            {t('loading.errorTitle')}
          </p>
          <p className="text-[13px] leading-5 text-text-2">{message}</p>
        </div>
        <button type="button" onClick={onRetry} className={cn(AUTH_PRIMARY_BASE_CLASS, 'min-w-40')}>
          {t('loading.retry')}
        </button>
      </div>
    </div>
  );
}
