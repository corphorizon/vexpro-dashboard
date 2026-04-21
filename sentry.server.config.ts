// Sentry — Node (serverless) runtime init.
// Same unconditional call pattern as client: SDK no-ops with empty dsn,
// avoids tree-shake surprises.

import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.VERCEL_ENV || 'development',
  tracesSampleRate: 0.1,
  // Drop obvious noise (bot health checks, client-cancelled requests).
  beforeSend(event, hint) {
    const err = hint?.originalException;
    if (err instanceof Error && err.name === 'AbortError') return null;
    return event;
  },
});
