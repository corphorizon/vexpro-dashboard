// ─────────────────────────────────────────────────────────────────────────────
// API Integrations — Retry helper
//
// Generic retry-with-exponential-backoff wrapper for fetch calls.
// Used by all provider clients to handle transient failures + rate limits.
// ─────────────────────────────────────────────────────────────────────────────

import { RETRY_MAX_ATTEMPTS, RETRY_BACKOFF_MS } from './config';

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; backoffMs?: number } = {}
): Promise<T> {
  const max = opts.maxAttempts ?? RETRY_MAX_ATTEMPTS;
  const base = opts.backoffMs ?? RETRY_BACKOFF_MS;

  let lastError: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Detect rate-limit signals from common providers
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      const isRateLimit = msg.includes('429') || msg.includes('rate limit');
      const wait = isRateLimit ? base * attempt * 4 : base * attempt;
      if (attempt < max) {
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Unknown retry failure');
}
