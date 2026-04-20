-- =============================================================================
-- Migration 024: fix auth_company_ids() — CASE subquery was returning >1 row
-- =============================================================================
--
-- Bug introduced in migration 021: the CASE branch
--     WHEN is_superadmin() THEN (SELECT id FROM companies)
-- is a scalar context. When the companies table has 2+ rows the subquery
-- returns multiple rows, Postgres raises
--     "more than one row returned by a subquery used as an expression"
-- and every RLS SELECT that uses auth_company_ids() fails.
--
-- Symptom: superadmin trying to read companies / any scoped table once the
-- platform has more than one tenant (e.g. VexPro + a test company) sees
-- "No se encontró la empresa".
--
-- Fix: rewrite using UNION. Normal users return their memberships; superadmin
-- additionally gets every company row. The `WHERE is_superadmin()` filter in
-- the second half makes that branch return zero rows for everyone else, which
-- is what we want.
-- =============================================================================

CREATE OR REPLACE FUNCTION auth_company_ids() RETURNS SETOF UUID AS $$
  SELECT company_id
  FROM company_users
  WHERE user_id = auth.uid()
  UNION
  SELECT id
  FROM companies
  WHERE is_superadmin()
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

COMMENT ON FUNCTION auth_company_ids() IS
  'Company IDs visible to the current user. Union of company_users memberships with ALL companies when the caller is a superadmin.';

-- Quick smoke test (run in SQL editor as a superadmin):
--   SELECT COUNT(*) FROM (SELECT auth_company_ids()) AS t;
-- Expected: number of tenants in companies table.
--
-- As a normal member user:
--   SELECT COUNT(*) FROM (SELECT auth_company_ids()) AS t;
-- Expected: count of their memberships (usually 1).
