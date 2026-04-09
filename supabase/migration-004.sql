-- ================================================
-- MIGRATION 004 — Close the "Allow public read access" hole
--
-- BACKGROUND
-- Every table in public had TWO layers of RLS policies:
--   1. "Allow public read access"         (qual = true)  — legacy, wide open
--      "Allow authenticated insert/update/delete" (true) — legacy, wide open
--   2. <table>_select / _insert / _update / _delete    — company-scoped (safe)
--
-- Postgres combines permissive policies with OR, so the legacy "true"
-- policies effectively neutralised the company-scoped ones. ANY user with
-- the anon key could SELECT all financial data across all tenants, and any
-- authenticated user could INSERT/UPDATE/DELETE rows in other companies.
--
-- This migration drops the legacy policies. The company-scoped policies
-- already exist for every table (verified by scripts/db-admin/check-policy-coverage.mjs)
-- so no replacement is needed.
--
-- SAFE TO RUN MULTIPLE TIMES (DROP POLICY IF EXISTS).
-- Run after migration-003.sql.
-- ================================================

BEGIN;

-- ── Read-only leaks (SELECT with qual = true) ──────────────────────────
DROP POLICY IF EXISTS "Allow public read access" ON broker_balance;
DROP POLICY IF EXISTS "Allow public read access" ON commercial_monthly_results;
DROP POLICY IF EXISTS "Allow public read access" ON commercial_profiles;
DROP POLICY IF EXISTS "Allow public read access" ON companies;
DROP POLICY IF EXISTS "Allow public read access" ON company_users;
DROP POLICY IF EXISTS "Allow public read access" ON deposits;
DROP POLICY IF EXISTS "Allow public read access" ON employees;
DROP POLICY IF EXISTS "Allow public read access" ON expenses;
DROP POLICY IF EXISTS "Allow public read access" ON financial_status;
DROP POLICY IF EXISTS "Allow public read access" ON investments;
DROP POLICY IF EXISTS "Allow public read access" ON liquidity_movements;
DROP POLICY IF EXISTS "Allow public read access" ON operating_income;
DROP POLICY IF EXISTS "Allow public read access" ON p2p_transfers;
DROP POLICY IF EXISTS "Allow public read access" ON partner_distributions;
DROP POLICY IF EXISTS "Allow public read access" ON partners;
DROP POLICY IF EXISTS "Allow public read access" ON periods;
DROP POLICY IF EXISTS "Allow public read access" ON preoperative_expenses;
DROP POLICY IF EXISTS "Allow public read access" ON prop_firm_sales;
DROP POLICY IF EXISTS "Allow public read access" ON withdrawals;

-- ── Write leaks on financial tables (INSERT/UPDATE/DELETE with true) ───
DROP POLICY IF EXISTS "Allow authenticated insert" ON deposits;
DROP POLICY IF EXISTS "Allow authenticated update" ON deposits;
DROP POLICY IF EXISTS "Allow authenticated delete" ON deposits;

DROP POLICY IF EXISTS "Allow authenticated insert" ON expenses;
DROP POLICY IF EXISTS "Allow authenticated update" ON expenses;
DROP POLICY IF EXISTS "Allow authenticated delete" ON expenses;

DROP POLICY IF EXISTS "Allow authenticated insert" ON investments;
DROP POLICY IF EXISTS "Allow authenticated update" ON investments;
DROP POLICY IF EXISTS "Allow authenticated delete" ON investments;

DROP POLICY IF EXISTS "Allow authenticated insert" ON liquidity_movements;
DROP POLICY IF EXISTS "Allow authenticated update" ON liquidity_movements;
DROP POLICY IF EXISTS "Allow authenticated delete" ON liquidity_movements;

DROP POLICY IF EXISTS "Allow authenticated insert" ON operating_income;
DROP POLICY IF EXISTS "Allow authenticated update" ON operating_income;
DROP POLICY IF EXISTS "Allow authenticated delete" ON operating_income;

DROP POLICY IF EXISTS "Allow authenticated insert" ON withdrawals;
DROP POLICY IF EXISTS "Allow authenticated update" ON withdrawals;
DROP POLICY IF EXISTS "Allow authenticated delete" ON withdrawals;

-- Older naming pattern used by 2 tables:
DROP POLICY IF EXISTS "Users can insert p2p_transfers" ON p2p_transfers;
DROP POLICY IF EXISTS "Users can update p2p_transfers" ON p2p_transfers;
DROP POLICY IF EXISTS "Users can delete p2p_transfers" ON p2p_transfers;

DROP POLICY IF EXISTS "Users can insert prop_firm_sales" ON prop_firm_sales;
DROP POLICY IF EXISTS "Users can update prop_firm_sales" ON prop_firm_sales;
DROP POLICY IF EXISTS "Users can delete prop_firm_sales" ON prop_firm_sales;

-- ── Tenant-creation backdoor ───────────────────────────────────────────
-- companies_insert had with_check = true → any authenticated user could
-- create a new company row. This is a B2B internal tool where Kevin
-- provisions tenants, so lock it down to admins only.
DROP POLICY IF EXISTS "companies_insert" ON companies;
CREATE POLICY "companies_insert" ON companies
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

COMMIT;

-- ── Verification ───────────────────────────────────────────────────────
-- After running, there should be ZERO rows here.
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND (qual = 'true' OR with_check = 'true')
ORDER BY tablename, cmd;
