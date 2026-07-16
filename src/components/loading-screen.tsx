'use client';

import { useEffect, useState } from 'react';

interface LoadingScreenProps {
  message?: string;
  /**
   * Optional retry callback. When provided AND the loader has been visible
   * for more than `slowHintAfterMs` (default 5000ms), a "Está tardando…"
   * hint + a "Reintentar ahora" button are rendered below the spinner.
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
}

/**
 * Branded full-screen loading state.
 *
 * Renders a neutral "Smart Dashboard" mark — this screen can show for
 * superadmin navigation (no tenant context yet) or during the initial
 * data load, so using a tenant logo here would be wrong.
 */
export function LoadingScreen({
  message,
  onRetry,
  slowHintAfterMs = 5000,
}: LoadingScreenProps) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), slowHintAfterMs);
    return () => clearTimeout(t);
  }, [slowHintAfterMs]);

  return (
    <div className="flex h-full min-h-[60vh] w-full items-center justify-center px-6 vex-fade-in">
      <div className="flex flex-col items-center gap-6">
        <div className="vex-logo-pulse">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/smart-dashboard-dark.png"
            alt="Smart Dashboard"
            width={96}
            height={96}
            className="block dark:hidden h-24 w-24 object-contain mx-auto"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/smart-dashboard-white.png"
            alt="Smart Dashboard"
            width={96}
            height={96}
            className="hidden dark:block h-24 w-24 object-contain mx-auto"
          />
        </div>
        <div className="vex-bar-track" role="progressbar" aria-label="Cargando">
          <div className="vex-bar-fill" />
        </div>
        {message && (
          <p className="text-xs text-muted-foreground">{message}</p>
        )}
        {slow && (
          <div className="mt-2 flex flex-col items-center gap-2 text-center max-w-xs">
            <p className="text-xs text-muted-foreground">
              Está tardando más de lo normal. Verifica tu conexión.
            </p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
              >
                Reintentar ahora
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
 * Branded error screen shown when initial data load fails or times out.
 */
export function LoadingError({ message, onRetry }: LoadingErrorProps) {
  return (
    <div className="flex h-full min-h-[60vh] w-full items-center justify-center px-6 vex-fade-in">
      <div className="flex flex-col items-center gap-5 text-center max-w-md">
        <div className="opacity-80">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/smart-dashboard-dark.png"
            alt="Smart Dashboard"
            width={80}
            height={80}
            className="block dark:hidden h-20 w-20 object-contain mx-auto"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/smart-dashboard-white.png"
            alt="Smart Dashboard"
            width={80}
            height={80}
            className="hidden dark:block h-20 w-20 object-contain mx-auto"
          />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-negative">
            No pudimos cargar los datos
          </p>
          <p className="text-xs text-muted-foreground">{message}</p>
        </div>
        <button
          onClick={onRetry}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Reintentar
        </button>
      </div>
    </div>
  );
}
