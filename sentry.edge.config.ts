// Sentry — Edge runtime (middleware + edge route handlers).
// Same DSN as server.config but uses the lightweight edge-compatible SDK
// surface. Kept as a separate file because @sentry/nextjs reads each one
// at its respective build target.

import * as Sentry from '@sentry/nextjs';

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV || 'development',
    tracesSampleRate: 0.1,
  });
}
