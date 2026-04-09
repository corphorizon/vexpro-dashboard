-- ================================================
-- MIGRATION 005 — Index hygiene
--
-- Two low-risk fixes surfaced by scripts/db-admin/audit.mjs:
--
--   A. Drop 4 redundant indexes that duplicate a UNIQUE constraint's
--      implicit index. Each one doubles the write cost and wastes disk
--      for zero benefit — the unique-constraint index already serves
--      every lookup those `idx_*` indexes were meant to accelerate.
--
--   B. Create 2 missing indexes on foreign-key columns so cascading
--      deletes / reverse lookups don't seq-scan. Still cheap today
--      (tiny row counts) but cheap to add and required before scale.
--
-- Safe to run multiple times (IF EXISTS / IF NOT EXISTS).
-- Run after migration-004.sql.
-- ================================================

BEGIN;

-- ── A. Drop redundant duplicate indexes ────────────────────────────────
-- Each of these duplicates the unique constraint index on (company_id, period_id)
-- or (profile_id, period_id). The constraint's own index stays.
DROP INDEX IF EXISTS idx_operating_income_company_period;
DROP INDEX IF EXISTS idx_broker_balance_company_period;
DROP INDEX IF EXISTS idx_financial_status_company_period;
DROP INDEX IF EXISTS idx_commercial_monthly_results_profile_period;

-- ── B. Add missing FK indexes ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_partners_user_id
  ON partners (user_id);

CREATE INDEX IF NOT EXISTS idx_partner_distributions_partner_id
  ON partner_distributions (partner_id);

COMMIT;

-- ── Verification ───────────────────────────────────────────────────────
-- Expect: no rows for the 4 dropped indexes, and 2 new idx_* rows present.
SELECT schemaname, tablename, indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND (
    indexname IN (
      'idx_operating_income_company_period',
      'idx_broker_balance_company_period',
      'idx_financial_status_company_period',
      'idx_commercial_monthly_results_profile_period',
      'idx_partners_user_id',
      'idx_partner_distributions_partner_id'
    )
  )
ORDER BY indexname;
