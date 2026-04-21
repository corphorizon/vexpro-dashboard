// ─────────────────────────────────────────────────────────────────────────────
// Sentry — browser-side initialisation.
//
// Next.js 15+/16 replaced the old `sentry.client.config.ts` convention
// with `instrumentation-client.ts`. The @sentry/nextjs webpack plugin
// loads whichever file exists, but only the new name works with
// Turbopack.
//
// We call Sentry.init() unconditionally — the SDK no-ops when dsn is
// empty, and wrapping it in `if (dsn)` causes tree-shake to strip the
// whole SDK out of the bundle when builds run without the env var set.
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
