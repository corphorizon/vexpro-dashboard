-- =============================================================================
-- Migration 023: Add status + created_by to companies
-- =============================================================================
--
-- Kevin's Phase 1 spec listed these two columns but they were left for later
-- to keep migrations 021/022 narrowly scoped. Phase 4 (superadmin panel)
-- actually needs them: the "Deactivate entity" button flips `status`, and
-- "Created by" tracks which superadmin provisioned each tenant.
--
-- Both are additive + nullable/defaulted → no backfill or downtime risk.
-- =============================================================================

BEGIN;

-- status: 'active' | 'inactive'. Default active so existing rows inherit it.
-- We use a CHECK constraint rather than a Postgres ENUM so we can extend the
-- set later without a drop-recreate dance.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive'));

COMMENT ON COLUMN companies.status IS
  'Tenant lifecycle state. inactive = disabled (no login, still readable in superadmin panel).';

-- created_by: FK to auth.users. Nullable because the original VexPro row
-- predates this column and we don''t want to invent a creator for it.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN companies.created_by IS
  'The auth.user (typically a superadmin) that provisioned this tenant.';

-- Helper index for filtering by status in the panel.
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);

COMMIT;

-- =============================================================================
-- VERIFICATION
-- =============================================================================
--
-- 1. Both columns exist:
--      SELECT column_name, data_type, is_nullable, column_default
--      FROM information_schema.columns
--      WHERE table_name = 'companies' AND column_name IN ('status','created_by');
--
-- 2. VexPro inherited status='active':
--      SELECT name, slug, status, created_by FROM companies WHERE slug = 'vexprofx';
-- =============================================================================
