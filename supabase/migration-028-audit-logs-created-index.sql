-- =============================================================================
-- Migration 028: Composite index on audit_logs (company_id, created_at DESC)
-- =============================================================================
--
-- Audit queries ALWAYS filter by company_id and ORDER BY created_at DESC
-- (see /api/superadmin/companies/:id/audit-logs, the CompanyAuditPanel, and
-- the per-user recent history in /superadmin/companies/[id]/users). Today
-- we have `idx_audit_logs_company_id` but no sort-covering index, so every
-- query pays for an in-memory sort after the filter.
--
-- With this composite (DESC on created_at), Postgres can:
--   1. Seek into the index for the company
--   2. Walk in reverse chronological order — no sort step
--   3. Return directly without an extra fetch when the query is covered
--
-- Cheap: additive, idempotent, CONCURRENTLY to avoid locking during rebuild.
-- =============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_logs_company_created
  ON audit_logs(company_id, created_at DESC);

-- Verification:
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT * FROM audit_logs
--   WHERE company_id = '...' ORDER BY created_at DESC LIMIT 50;
-- Expected plan: "Index Scan Backward using idx_audit_logs_company_created"
