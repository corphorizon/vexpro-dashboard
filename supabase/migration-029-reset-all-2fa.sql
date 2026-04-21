-- =============================================================================
-- Migration 029: Reset ALL 2FA + force re-enrolment on next login
-- =============================================================================
--
-- Kevin's protocol after the Smart Dashboard cutover: wipe every TOTP
-- secret (company_users + platform_users) and force every account,
-- including superadmins, to configure a fresh authenticator on next login.
--
-- Two concrete changes:
--
--   1. platform_users gets a `force_2fa_setup` column (company_users got
--      this in migration-015; superadmins were exempt before). Default
--      true so any row we insert later also lands in the must-setup state.
--
--   2. Wipe 2FA state across both tables:
--        · twofa_enabled        → false
--        · twofa_secret         → NULL     (current TOTP seed)
--        · twofa_pending_secret → NULL     (in-flight enrolment)
--        · twofa_pending_at     → NULL     (pending timestamp)
--        · force_2fa_setup      → true     (redirects to /setup-2fa)
--
-- Also clears twofa_attempts so anyone that was locked out starts clean.
--
-- Idempotent + safe: no destructive data drop, columns just get overwritten.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. platform_users.force_2fa_setup
-- ---------------------------------------------------------------------------
ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS force_2fa_setup boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN platform_users.force_2fa_setup IS
  'When true, redirect the superadmin to /setup-2fa on next login. Cleared after successful enrolment.';

-- ---------------------------------------------------------------------------
-- 2. Wipe 2FA state for every existing tenant user
-- ---------------------------------------------------------------------------
UPDATE company_users
SET
  twofa_enabled        = false,
  twofa_secret         = NULL,
  twofa_pending_secret = NULL,
  twofa_pending_at     = NULL,
  force_2fa_setup      = true,
  updated_at           = now();

-- ---------------------------------------------------------------------------
-- 3. Wipe 2FA state for every superadmin
-- ---------------------------------------------------------------------------
UPDATE platform_users
SET
  twofa_enabled   = false,
  twofa_secret    = NULL,
  force_2fa_setup = true,
  updated_at      = now();

-- ---------------------------------------------------------------------------
-- 4. Clear rate-limit attempts so nobody starts locked out
-- ---------------------------------------------------------------------------
DELETE FROM twofa_attempts;

COMMIT;

-- =============================================================================
-- VERIFICATION
-- =============================================================================
--
-- SELECT COUNT(*) FILTER (WHERE twofa_enabled) AS still_enabled,
--        COUNT(*) FILTER (WHERE twofa_secret IS NOT NULL) AS still_has_secret,
--        COUNT(*) FILTER (WHERE force_2fa_setup = false) AS still_skipping,
--        COUNT(*) AS total
-- FROM company_users;
--
-- SELECT COUNT(*) FILTER (WHERE twofa_enabled) AS still_enabled,
--        COUNT(*) FILTER (WHERE twofa_secret IS NOT NULL) AS still_has_secret,
--        COUNT(*) FILTER (WHERE force_2fa_setup = false) AS still_skipping,
--        COUNT(*) AS total
-- FROM platform_users;
--
-- Expected: still_enabled=0, still_has_secret=0, still_skipping=0 for both.
-- =============================================================================
