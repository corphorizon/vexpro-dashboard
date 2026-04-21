// ─────────────────────────────────────────────────────────────────────────────
// Sentry — browser-side initialisation.
//
// Loaded automatically by @sentry/nextjs on every page that runs client JS.
//
// We call Sentry.init() unconditionally (SDK no-ops when dsn is falsy)
// because wrapping it in `if (dsn)` tree-shakes the SDK out of the bundle
// whenever the build runs without the env var set — including the very
// first deploy after adding it to Vercel.
// ─────────────────────────────────────────────────────────────────────────────

import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || 'development',

  // Keep the free-tier bill predictable. 10% of transactions sampled for
  // performance monitoring; errors are always 100%.
  tracesSampleRate: 0.1,

  // No replay by default — avoids capturing PII in recorded UI sessions.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
});
