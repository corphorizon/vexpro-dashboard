import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// The schema is internal to env.ts — we re-declare a copy here for tests
// to avoid coupling the test to the singleton/proxy behaviour. If you
// change the production schema, mirror the changes here.

const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  API_CREDENTIALS_MASTER_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  SENDGRID_API_KEY: z.string().startsWith('SG.').optional(),
  SENDGRID_FROM_EMAIL: z.string().email().optional(),
  CRON_SECRET: z.string().min(16).optional(),
});

const valid = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://krohysnnppwcetdjhyyz.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'a'.repeat(100),
  SUPABASE_SERVICE_ROLE_KEY: 'b'.repeat(100),
  API_CREDENTIALS_MASTER_KEY: 'a'.repeat(64),
  CRON_SECRET: 'a'.repeat(16),
};

describe('serverSchema', () => {
  it('accepts a fully-valid env', () => {
    const r = serverSchema.safeParse(valid);
    expect(r.success).toBe(true);
  });

  it('rejects an invalid Supabase URL', () => {
    const r = serverSchema.safeParse({ ...valid, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' });
    expect(r.success).toBe(false);
  });

  it('rejects a master key that is not 64 hex chars', () => {
    expect(
      serverSchema.safeParse({ ...valid, API_CREDENTIALS_MASTER_KEY: 'short' }).success,
    ).toBe(false);
    expect(
      serverSchema.safeParse({
        ...valid,
        API_CREDENTIALS_MASTER_KEY: 'g'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('rejects a SendGrid key that does not start with SG.', () => {
    const r = serverSchema.safeParse({
      ...valid,
      SENDGRID_API_KEY: 'not-a-sendgrid-key',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a short cron secret (brute-force risk)', () => {
    const r = serverSchema.safeParse({ ...valid, CRON_SECRET: 'abc' });
    expect(r.success).toBe(false);
  });
});
