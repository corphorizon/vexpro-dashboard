-- Migration 015: auth hardening
--
--   1. Extends company_users with:
--      - failed_login_count / locked_until  → 3 failed attempts lockout
--      - force_2fa_setup                     → require 2FA setup on first login
--      - must_change_password                → force password change after admin reset or lockout
--
--   2. Creates password_reset_tokens — short-lived tokens for self-service
--      password recovery via email link. One-shot (consumed_at).
--
--   3. Creates twofa_reset_codes — 6-digit numeric codes sent by email for
--      self-service 2FA reset. 15-minute TTL, 3-attempt cap.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. company_users hardening columns
-- ---------------------------------------------------------------------------
ALTER TABLE company_users
  ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS force_2fa_setup boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN company_users.locked_until IS
  'When set in the future, the account is locked. Cleared on successful auth or admin unlock.';
COMMENT ON COLUMN company_users.force_2fa_setup IS
  'If true, user is redirected to /setup-2fa until they enable 2FA. Defaults to true for new users.';
COMMENT ON COLUMN company_users.must_change_password IS
  'If true, user must change password on next login (after admin reset or lockout reset).';

-- Existing users who already have 2FA enabled should not be forced to set up again.
UPDATE company_users SET force_2fa_setup = false WHERE twofa_enabled = true;

-- ---------------------------------------------------------------------------
-- 2. password_reset_tokens
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,       -- SHA-256 of the token sent in email
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_ip text
);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
  ON password_reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_expires
  ON password_reset_tokens(expires_at);

ALTER TABLE password_reset_tokens DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE password_reset_tokens IS
  'Short-lived, single-use tokens for self-service password recovery. Only the hash is stored.';

-- ---------------------------------------------------------------------------
-- 3. twofa_reset_codes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS twofa_reset_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,               -- SHA-256 of the 6-digit code
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_twofa_reset_codes_user
  ON twofa_reset_codes(user_id);

ALTER TABLE twofa_reset_codes DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE twofa_reset_codes IS
  '6-digit numeric codes sent by email for self-service 2FA reset. 15-minute TTL.';

COMMIT;
