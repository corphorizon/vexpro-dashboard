// Durable rate limiting for auth endpoints, backed by Supabase.
//
// Works across serverless workers (unlike an in-memory Map).
//
// Usage:
//   const gate = await checkRateLimit(adminClient, { key, kind, max: 3, lockMs: 15*60_000 });
//   if (gate.locked) return 429 with gate.waitMs
//   ... do verification ...
//   if (failed) await recordFailure(adminClient, { key, kind, max, lockMs });
//   if (success) await clearAttempts(adminClient, { key, kind });

import type { SupabaseClient } from '@supabase/supabase-js';

export type AttemptKind = 'verify-2fa' | 'verify-pin' | 'forgot-password';

export interface RateLimitOptions {
  key: string;
  kind: AttemptKind;
  max: number;        // max failed attempts before lock
  lockMs: number;     // lockout duration (ms)
}

export interface RateLimitState {
  locked: boolean;
  waitMs: number;
  failedCount: number;
}

export async function checkRateLimit(
  adminClient: SupabaseClient,
  opts: Pick<RateLimitOptions, 'key' | 'kind'>,
): Promise<RateLimitState> {
  const { data } = await adminClient
    .from('twofa_attempts')
    .select('failed_count, locked_until')
    .eq('key', opts.key)
    .eq('kind', opts.kind)
    .maybeSingle();

  if (!data) return { locked: false, waitMs: 0, failedCount: 0 };

  const lockedUntil = data.locked_until ? new Date(data.locked_until).getTime() : 0;
  const now = Date.now();
  if (lockedUntil > now) {
    return { locked: true, waitMs: lockedUntil - now, failedCount: data.failed_count };
  }
  return { locked: false, waitMs: 0, failedCount: data.failed_count };
}

export async function recordFailure(
  adminClient: SupabaseClient,
  opts: RateLimitOptions,
): Promise<RateLimitState> {
  const { data: existing } = await adminClient
    .from('twofa_attempts')
    .select('failed_count')
    .eq('key', opts.key)
    .eq('kind', opts.kind)
    .maybeSingle();

  const newCount = (existing?.failed_count ?? 0) + 1;
  const shouldLock = newCount >= opts.max;
  const lockedUntil = shouldLock ? new Date(Date.now() + opts.lockMs).toISOString() : null;

  await adminClient.from('twofa_attempts').upsert(
    {
      key: opts.key,
      kind: opts.kind,
      failed_count: newCount,
      locked_until: lockedUntil,
      last_attempt_at: new Date().toISOString(),
    },
    { onConflict: 'key,kind' },
  );

  return {
    locked: shouldLock,
    waitMs: shouldLock ? opts.lockMs : 0,
    failedCount: newCount,
  };
}

export async function clearAttempts(
  adminClient: SupabaseClient,
  opts: Pick<RateLimitOptions, 'key' | 'kind'>,
): Promise<void> {
  await adminClient
    .from('twofa_attempts')
    .delete()
    .eq('key', opts.key)
    .eq('kind', opts.kind);
}
