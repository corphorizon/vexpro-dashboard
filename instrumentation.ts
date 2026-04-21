// ─────────────────────────────────────────────────────────────────────────────
// Next.js instrumentation hook (required by @sentry/nextjs v10+).
//
// `register()` runs once per server process, before any requests are
// handled. We load the appropriate Sentry config based on the runtime
// Next is booting (Node for serverless functions, Edge for middleware
// + edge routes). Both configs read SENTRY_DSN from env.
//
// `onRequestError` forwards every server render / route handler error
// to Sentry so unhandled exceptions don't silently disappear.
// ─────────────────────────────────────────────────────────────────────────────

import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
