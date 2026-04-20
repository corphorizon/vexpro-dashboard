-- =============================================================================
-- Migration 025: Add status + last_login_at to company_users
-- =============================================================================
--
-- The Superadmin "Manage users" panel needs to:
--   1. Deactivate a user without deleting their row (status = 'inactive')
--   2. Show "Last access" per user in the list
--
-- Both columns are additive + defaulted → no downtime.
-- The login-gate API updates last_login_at on successful 2FA verification.
-- =============================================================================

BEGIN;

ALTER TABLE company_users
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive'));

COMMENT ON COLUMN company_users.status IS
  'Per-membership state. inactive = user cannot access this tenant; row kept for audit continuity.';

ALTER TABLE company_users
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

COMMENT ON COLUMN company_users.last_login_at IS
  'Timestamp of the most recent successful login for this membership. Updated by the login-gate API.';

CREATE INDEX IF NOT EXISTS idx_company_users_status ON company_users(status);

COMMIT;
