-- =============================================================================
-- Migration 030: Add twofa_pending_secret + twofa_pending_at to platform_users
-- =============================================================================
--
-- Migration 029 forced every superadmin into "must re-enrol 2FA" state but
-- didn't give platform_users the intermediate pending-secret columns that
-- the /api/auth/setup-2fa flow expects. company_users got these in
-- migration-014; now superadmins get them too so the same enrolment path
-- works for both tables.
--
-- How the pending flow works:
--   1. Client POSTs { action: 'generate' } → server creates a TOTP secret
--      and writes it to twofa_pending_secret + stamps twofa_pending_at.
--      The plaintext is also shown to the user once (QR + text) so they
--      can scan it into their authenticator app.
--   2. Client POSTs { action: 'verify', token } → server checks the token
--      against the pending secret. On success, promote it to twofa_secret,
--      set twofa_enabled=true, clear pending_secret/at and force_2fa_setup.
--
-- The pending state auto-expires after 10 minutes (enforced in the API).
-- If the user never finishes the verify step, the pending secret lingers
-- in the row but is treated as expired on the next generate.
--
-- Additive + nullable: zero-risk.
-- =============================================================================

BEGIN;

ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS twofa_pending_secret text,
  ADD COLUMN IF NOT EXISTS twofa_pending_at     timestamptz;

COMMENT ON COLUMN platform_users.twofa_pending_secret IS
  'TOTP secret generated server-side during setup, promoted to twofa_secret after successful verify. Expires after 10 minutes.';
COMMENT ON COLUMN platform_users.twofa_pending_at IS
  'Timestamp of the pending-secret issuance. Used to expire stale pending setups.';

COMMIT;
