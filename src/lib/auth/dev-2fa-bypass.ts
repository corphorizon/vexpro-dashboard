// ─────────────────────────────────────────────────────────────────────────────
// Dev-only 2FA bypass.
//
// Enables local development without the constant "ingresá tu PIN" friction
// when working offline / re-seeding the DB. DOUBLE-GATED so it can never
// leak to production:
//
//   Server-side:
//     1. NODE_ENV must NOT be 'production' (Vercel always sets it
//        to 'production' on deployed builds).
//     2. DEV_SKIP_2FA must be === 'true'.
//
//   Client-side:
//     1. window.location.hostname must be localhost / 127.0.0.1 / 0.0.0.0.
//     2. NEXT_PUBLIC_DEV_SKIP_2FA must be === 'true'.
//
// Even if someone accidentally pushes NEXT_PUBLIC_DEV_SKIP_2FA=true to
// Vercel, the hostname gate on the client + the NODE_ENV gate on the
// server both refuse to disable 2FA on the real domain.
//
// Usage:
//   - login-gate /api/auth/login-gate → response `needs2fa: false`
//   - (dashboard)/layout.tsx          → skip force_2fa_setup redirect
//   - superadmin/layout.tsx           → same
// ─────────────────────────────────────────────────────────────────────────────

const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

export function isDev2faBypassEnabled(): boolean {
  if (typeof window === 'undefined') {
    // Server-side path. Vercel runtime → NODE_ENV='production' blocks this.
    if (process.env.NODE_ENV === 'production') return false;
    return process.env.DEV_SKIP_2FA === 'true';
  }
  // Client-side path. Must be running on a local hostname AND have the
  // public flag set. We require BOTH so a stray env var in prod is still
  // blocked by the hostname check.
  if (!LOCALHOST_HOSTS.has(window.location.hostname)) return false;
  return process.env.NEXT_PUBLIC_DEV_SKIP_2FA === 'true';
}
