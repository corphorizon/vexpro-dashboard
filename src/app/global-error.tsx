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
// ─────────────────────────────────────────────────────────────────────────────

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  // global-error replaces the entire <html>/<body> when triggered — so we
  // ship a self-contained shell (no providers/layout). Keep it minimal:
  // English + Spanish so it's understandable regardless of locale state.
  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#F1F5F9',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          color: '#334155',
        }}
      >
        <div
          style={{
            maxWidth: 480,
            background: '#ffffff',
            border: '1px solid #E2E8F0',
            borderRadius: 12,
            padding: '28px 32px',
            boxShadow: '0 2px 10px rgba(15, 23, 42, 0.06)',
            textAlign: 'center',
          }}
        >
          <h1 style={{ fontSize: 22, color: '#1E3A5F', margin: '0 0 8px 0' }}>
            Algo salió mal
          </h1>
          <p style={{ fontSize: 14, color: '#64748B', margin: '0 0 18px 0' }}>
            Se produjo un error inesperado. El equipo fue notificado automáticamente.
          </p>
          {error.digest && (
            <p
              style={{
                fontSize: 11,
                color: '#94A3B8',
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                margin: '0 0 18px 0',
              }}
            >
              ID: {error.digest}
            </p>
          )}
          <button
            onClick={() => reset()}
            style={{
              background: '#1E3A5F',
              color: '#ffffff',
              border: 'none',
              borderRadius: 8,
              padding: '10px 20px',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reintentar
          </button>
        </div>
      </body>
    </html>
  );
}
