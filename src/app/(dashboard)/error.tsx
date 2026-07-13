'use client';

// LNK-04: error boundary del segmento (dashboard). Captura errores de render
// dentro de la app (con providers/layout ya montados, a diferencia de
// global-error.tsx que reemplaza todo el <html>). Reporta a Sentry y ofrece
// reintentar sin recargar toda la página.

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center rounded-2xl border border-border bg-card p-8 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">Algo salió mal</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ocurrió un error al mostrar esta sección. Ya lo registramos; podés
          reintentar.
        </p>
        {error.digest && (
          <p className="mt-2 text-xs text-muted-foreground/70">Ref: {error.digest}</p>
        )}
        <button
          onClick={reset}
          className="mt-6 inline-flex items-center justify-center rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        >
          Reintentar
        </button>
      </div>
    </div>
  );
}
