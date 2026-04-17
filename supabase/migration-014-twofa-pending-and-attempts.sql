-- Migration 014: TOTP pending secrets + login attempts tracking
--
-- 1. Adds a server-side "pending" TOTP secret to company_users so the verify
--    step does NOT trust the secret from the client body. Prevents an attacker
--    with XSS during the setup flow from swapping the secret at verify time.
--
-- 2. Creates a twofa_attempts table for durable rate limiting across
--    serverless workers (replaces the in-memory Map that doesn't work on
--    Vercel multi-instance).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Pending TOTP secret columns
-- ---------------------------------------------------------------------------
ALTER TABLE company_users
  ADD COLUMN IF NOT EXISTS twofa_pending_secret text,
  ADD COLUMN IF NOT EXISTS twofa_pending_at timestamptz;

COMMENT ON COLUMN company_users.twofa_pending_secret IS
  'TOTP secret generated server-side during setup, promoted to twofa_secret after successful verify. Expires after 10 minutes.';

-- ---------------------------------------------------------------------------
-- 2. Rate-limit tracking for 2FA / PIN verification
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS twofa_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,                 -- email or user_id
  kind text NOT NULL,                -- 'verify-2fa' | 'verify-pin'
  failed_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT twofa_attempts_unique UNIQUE (key, kind)
);

CREATE INDEX IF NOT EXISTS idx_twofa_attempts_key_kind
  ON twofa_attempts(key, kind);

-- No RLS: only the service role (admin client) touches this table.
ALTER TABLE twofa_attempts DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE twofa_attempts IS
  'Durable rate-limit state for 2FA / PIN endpoints. Works across serverless workers.';

COMMIT;
