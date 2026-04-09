-- ================================================
-- MIGRATION 003 — HR role CRUD permissions
--
-- Extends RLS policies on the three HR tables so that users with
-- role = 'hr' can INSERT / UPDATE / DELETE employees, commercial
-- profiles and their monthly results — not only admins / auditors.
--
-- Before this migration the DELETE policies were admin-only, which is
-- why a user with role = 'hr' could see the RRHH page but any delete
-- or edit attempt silently no-op'd (RLS returned success with zero
-- rows affected).
--
-- Run this in the Supabase SQL editor after migration-002.sql.
-- Safe to run multiple times: every policy is dropped before being
-- recreated, and schema.sql has been updated to the same state so a
-- fresh database will match without needing this file.
-- ================================================


-- ── employees ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "employees_insert" ON employees;
DROP POLICY IF EXISTS "employees_update" ON employees;
DROP POLICY IF EXISTS "employees_delete" ON employees;

CREATE POLICY "employees_insert" ON employees
  FOR INSERT
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','auditor','hr')
    )
  );

CREATE POLICY "employees_update" ON employees
  FOR UPDATE
  USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','auditor','hr')
    )
  );

CREATE POLICY "employees_delete" ON employees
  FOR DELETE
  USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','hr')
    )
  );


-- ── commercial_profiles ────────────────────────────────────────────────
DROP POLICY IF EXISTS "commercial_profiles_insert" ON commercial_profiles;
DROP POLICY IF EXISTS "commercial_profiles_update" ON commercial_profiles;
DROP POLICY IF EXISTS "commercial_profiles_delete" ON commercial_profiles;

CREATE POLICY "commercial_profiles_insert" ON commercial_profiles
  FOR INSERT
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','auditor','hr')
    )
  );

CREATE POLICY "commercial_profiles_update" ON commercial_profiles
  FOR UPDATE
  USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','auditor','hr')
    )
  );

CREATE POLICY "commercial_profiles_delete" ON commercial_profiles
  FOR DELETE
  USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','hr')
    )
  );


-- ── commercial_monthly_results ─────────────────────────────────────────
-- HR also needs to maintain commission results rows for the profiles
-- they manage (loading a new period's payouts, correcting a wrong row).
DROP POLICY IF EXISTS "commercial_monthly_results_insert" ON commercial_monthly_results;
DROP POLICY IF EXISTS "commercial_monthly_results_update" ON commercial_monthly_results;
DROP POLICY IF EXISTS "commercial_monthly_results_delete" ON commercial_monthly_results;

CREATE POLICY "commercial_monthly_results_insert" ON commercial_monthly_results
  FOR INSERT
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','auditor','hr')
    )
  );

CREATE POLICY "commercial_monthly_results_update" ON commercial_monthly_results
  FOR UPDATE
  USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','auditor','hr')
    )
  );

CREATE POLICY "commercial_monthly_results_delete" ON commercial_monthly_results
  FOR DELETE
  USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','hr')
    )
  );


-- ── Sanity check (optional) ────────────────────────────────────────────
-- Shows which roles are now allowed per action on the HR tables.
SELECT tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename IN ('employees', 'commercial_profiles', 'commercial_monthly_results')
ORDER BY tablename, cmd;
