'use client';

import { ShieldCheck } from 'lucide-react';

interface LoadingScreenProps {
  message?: string;
}

/**
 * Branded full-screen loading state.
 *
 * Renders a neutral "Smart Dashboard" mark — this screen can show for
 * superadmin navigation (no tenant context yet) or during the initial
 * data load, so using a tenant logo here would be wrong.
 */
export function LoadingScreen({ message }: LoadingScreenProps) {
  return (
    <div className="flex h-full min-h-[60vh] w-full items-center justify-center px-6 vex-fade-in">
      <div className="flex flex-col items-center gap-6">
        <div className="vex-logo-pulse inline-flex items-center gap-2 text-slate-900 dark:text-white">
          <ShieldCheck className="w-8 h-8 text-amber-500" />
          <span className="font-semibold text-lg">Smart Dashboard</span>
        </div>
        <div className="vex-bar-track" role="progressbar" aria-label="Cargando">
          <div className="vex-bar-fill" />
        </div>
        {message && (
          <p className="text-xs text-muted-foreground">{message}</p>
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
        <div className="inline-flex items-center gap-2 text-slate-900 dark:text-white opacity-80">
          <ShieldCheck className="w-6 h-6 text-amber-500" />
          <span className="font-semibold">Smart Dashboard</span>
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-red-600 dark:text-red-400">
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
