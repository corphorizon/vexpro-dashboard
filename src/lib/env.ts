/**
 * Centralized environment variable validation.
 *
 * Kevin (2026-06-06, code review): si falta una env var crítica el código
 * antiguo solo explotaba en el primer use (típicamente al decrypt de una
 * credencial o al firmar un JWT), lo que dejaba al usuario con un 500
 * críptico y sin pista de qué configurar. Este módulo valida las envs
 * al BOOT con zod — si algo falta o tiene formato inválido, el log dice
 * exactamente qué setear y dónde.
 *
 * Usage:
 *   - Server code: `import { env } from '@/lib/env'`. Cualquier acceso
 *     dispara el parse perezoso una vez por proceso.
 *   - Client code: NO importar desde aquí. Las NEXT_PUBLIC_* viven en
 *     `clientEnv` abajo, separado para no filtrar tipos del server.
 *   - Tests: `env.__parse(overrides)` para inyectar valores.
 *
 * Why singletons: re-parsing per request es ~50μs pero llama a zod cada
 * import, lo cual contamina logs si tiramos un test sin envs (cada
 * import lanza). Singleton + lazy fixes that.
 */

import { z } from 'zod';

// ─── Server-only schema ──────────────────────────────────────────────────────
//
// Estos NUNCA deben llegar al bundle de browser. Si vez un import de `env`
// en un archivo `'use client'`, es un bug — usa `clientEnv` en su lugar.

const serverSchema = z.object({
  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL debe ser URL válida'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20, 'NEXT_PUBLIC_SUPABASE_ANON_KEY parece truncada'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'SUPABASE_SERVICE_ROLE_KEY parece truncada'),

  // Crypto for api_credentials encryption
  API_CREDENTIALS_MASTER_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'API_CREDENTIALS_MASTER_KEY debe ser 32 bytes hex (64 chars)'),

  // App
  NEXT_PUBLIC_APP_URL: z
    .string()
    .url('NEXT_PUBLIC_APP_URL debe ser URL completa con https://')
    .optional()
    .default('https://dashboard.horizonconsulting.ai'),

  // SendGrid (transactional email)
  SENDGRID_API_KEY: z
    .string()
    .startsWith('SG.', 'SENDGRID_API_KEY debe empezar con "SG."')
    .optional(),
  SENDGRID_FROM_EMAIL: z.string().email('SENDGRID_FROM_EMAIL debe ser email válido').optional(),
  SENDGRID_FROM_NAME: z.string().optional(),

  // Cron auth
  CRON_SECRET: z.string().min(16, 'CRON_SECRET debe tener al menos 16 chars').optional(),

  // Sentry (server-side)
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),

  // Node / runtime
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
});

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
});

export type ServerEnv = z.infer<typeof serverSchema>;
export type ClientEnv = z.infer<typeof clientSchema>;

// ─── Lazy singletons ────────────────────────────────────────────────────────

let cachedServerEnv: ServerEnv | undefined;
let cachedClientEnv: ClientEnv | undefined;

function formatIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

/**
 * Parse and validate process.env at first access. Subsequent imports
 * return the cached object. Throws (and logs to stderr) on any missing
 * or invalid var so the build/server fails LOUD instead of producing
 * cryptic 500s later.
 */
export function getServerEnv(): ServerEnv {
  if (cachedServerEnv) return cachedServerEnv;
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = formatIssues(parsed.error.issues);
    // eslint-disable-next-line no-console
    console.error(
      '[env] Server environment validation failed. Fix these vars in Vercel/.env:\n' +
        issues +
        '\nReference: src/lib/env.ts',
    );
    throw new Error(
      'Server environment validation failed. See logs for the list of missing/invalid vars.',
    );
  }
  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

export function getClientEnv(): ClientEnv {
  if (cachedClientEnv) return cachedClientEnv;
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  });
  if (!parsed.success) {
    const issues = formatIssues(parsed.error.issues);
    // eslint-disable-next-line no-console
    console.error('[env] Client environment validation failed:\n' + issues);
    throw new Error('Client environment validation failed.');
  }
  cachedClientEnv = parsed.data;
  return cachedClientEnv;
}

/**
 * Proxy used as `import { env } from '@/lib/env'` so consumers can write
 * `env.SENDGRID_API_KEY` without thinking about the parse step. Throws
 * the same loud error on first miss.
 */
export const env = new Proxy({} as ServerEnv, {
  get(_t, key: string) {
    const e = getServerEnv() as Record<string, unknown>;
    return e[key];
  },
}) as ServerEnv;

export const clientEnv = new Proxy({} as ClientEnv, {
  get(_t, key: string) {
    const e = getClientEnv() as Record<string, unknown>;
    return e[key];
  },
}) as ClientEnv;
