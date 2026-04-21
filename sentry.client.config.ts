// ─────────────────────────────────────────────────────────────────────────────
// Sentry — browser-side initialisation.
//
// Loaded automatically by @sentry/nextjs on every page that runs client JS.
// Keep this file lean — every byte ships to the user.
//
// Env-var gate: if NEXT_PUBLIC_SENTRY_DSN is unset Sentry is a no-op, so
// local dev and preview deploys without the DSN configured don't spam
// errors into the wrong project.
// ─────────────────────────────────────────────────────────────────────────────

import * as Sentry from '@sentry/nextjs';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    // Tag events by environment so we can split prod vs preview in the UI.
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || 'development',

    // Keep the bill predictable on the free tier (5k events/mo). The sample
    // rate means 10% of transactions are captured for perf monitoring.
    tracesSampleRate: 0.1,

    // Mask sensitive inputs in replays by default — we don't want passwords,
    // API credentials, or PII showing up in Sentry. Only enable session
    // replay if the user explicitly opted in (future feature).
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}
