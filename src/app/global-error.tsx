'use client';

// ─────────────────────────────────────────────────────────────────────────────
// global-error.tsx
//
// Next.js App Router entry point that catches React-render errors at the
// root layout level. Without this file, render-time exceptions bypass
// Sentry's regular instrumentation (which only wraps API/server code).
//
// Sentry warns about its absence at startup; adding this file silences
// that warning AND makes sure UI crashes get reported to the dashboard.
//
// Reference: https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/#react-render-errors-in-app-router
//
// «Libro mayor» (2026-10-12):
//   · Antes: estilos inline con 9 hex fijos (`#F1F5F9`, `#1E3A5F`…), siempre
//     claro. Next documenta que global-error NO recibe los estilos globales ni
//     la clase de tema (node_modules/next/dist/docs/…/error.md, «Global
//     Error»), así que acá se importa globals.css y se aplica `.dark` leyendo
//     la misma clave `fd_theme` que theme-context.tsx. Con eso usa tokens y
//     sigue el tema como el resto.
//   · Sin providers (reemplaza el layout raíz): no hay i18n. Se mantiene el
//     texto bilingüe fijo (es + en), que se entiende sin saber el idioma.
//   · `unstable_retry` (Next 16.2) vuelve a pedir y re-renderizar; `reset`
//     sólo re-renderiza. Se prefiere el primero si llega.
//
// DESCARTADO: un <script> inline para aplicar el tema antes de pintar (como
// hace ThemeProvider). Esta pantalla aparece después de un crash, no en la
// carga en frío; un frame en claro no justifica otro script inline.
// ─────────────────────────────────────────────────────────────────────────────

import './globals.css';
import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  unstable_retry?: () => void;
}

/** Mismo criterio que theme-context.tsx (`fd_theme`: light | dark | system). */
function prefersDark(): boolean {
  try {
    const t = localStorage.getItem('fd_theme');
    return t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch {
    return false;
  }
}

export default function GlobalError({ error, reset, unstable_retry }: GlobalErrorProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', prefersDark());
  }, []);

  const retry = unstable_retry ?? reset;

  return (
    <html lang="es">
      <body className="flex min-h-dvh items-center justify-center bg-background px-4 font-sans text-foreground antialiased">
        <title>Smart Dashboard</title>
        <main className="w-full max-w-[440px] rounded-ui-lg border border-border bg-card p-6 text-center shadow-1">
          <p className="text-[13px] font-semibold uppercase tracking-[.06em] text-text-3">Error</p>
          <h1 className="mt-1 text-[22px] font-[650] leading-7 tracking-[-0.015em]">
            Algo salió mal
            <span className="block text-[15px] font-medium tracking-normal text-text-2" lang="en">Something went wrong</span>
          </h1>
          <p className="mt-3 text-[13.5px] leading-5 text-text-2">
            Se produjo un error inesperado. El equipo fue notificado automáticamente.
          </p>
          <p className="mt-1 text-[13px] leading-5 text-text-3" lang="en">
            An unexpected error occurred. The team was notified automatically.
          </p>
          {error.digest && (
            <p className="mt-4 font-mono text-[12px] text-text-3">ID: {error.digest}</p>
          )}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => retry()}
              className="inline-flex h-10 min-w-40 items-center justify-center rounded-ui-md bg-primary px-4 text-[13.5px] font-medium text-brand-on-primary hover:bg-[color-mix(in_srgb,var(--color-primary)_86%,black)]"
            >
              Reintentar · Retry
            </button>
            {/* <a> y no <Link>: el router puede ser justo lo que se rompió. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a
              href="/"
              className="inline-flex h-10 items-center justify-center rounded-ui-md border border-border-strong bg-card px-4 text-[13px] font-medium text-foreground hover:bg-surface-hover"
            >
              Ir al inicio · Home
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
