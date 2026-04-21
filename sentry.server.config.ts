// ─────────────────────────────────────────────────────────────────────────────
// Sentry — Node (serverless) side.
//
// Captures errors from API routes, middleware, and server components.
// Uses SENTRY_DSN (non-public) so the DSN never ships to the browser
// through this path — @sentry/nextjs ALSO accepts NEXT_PUBLIC_SENTRY_DSN
// but keeping separate env vars lets us rotate them independently.
// ─────────────────────────────────────────────────────────────────────────────

import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || 'development',
    tracesSampleRate: 0.1,
    // Filter out obvious noise (bot health checks, abort signals, etc.)
    beforeSend(event, hint) {
      const err = hint?.originalException;
      if (err instanceof Error && err.name === 'AbortError') return null;
      return event;
    },
  });
}
