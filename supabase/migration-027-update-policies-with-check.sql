-- =============================================================================
-- Migration 027: Add WITH CHECK to every UPDATE policy
-- =============================================================================
--
-- Security fix identified in the audit (SEC-1 — 🔴 Crítico):
--
-- Migration 022 created UPDATE policies with only a USING clause:
--     CREATE POLICY ... FOR UPDATE USING (auth_can_edit(company_id))
--
-- In Postgres RLS:
--   * USING     — validates the row BEFORE update (filter-in)
--   * WITH CHECK — validates the row AFTER update (commit-gate)
--
-- Without WITH CHECK, an authenticated admin of Company A can execute:
--
--     UPDATE deposits SET company_id = '<Company-B-UUID>' WHERE id = '...'
--
-- and the USING check passes (row belongs to A), so the row is silently
-- pivoted to Company B — invisible to A's users, now readable by B.
--
-- This migration regenerates every UPDATE policy touched by migration 022
-- with a matching WITH CHECK clause. No changes to INSERT/DELETE policies.
--
-- Idempotent: safe to re-run. All DROP/CREATE pairs use IF EXISTS.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Regenerate UPDATE policies for every tenant-scoped business table
-- ---------------------------------------------------------------------------
-- Same list as migration-022 so we stay in sync. Tables are listed
-- explicitly to avoid accidentally touching audit_logs, api_*, etc.

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    -- core movement data
    'periods',
    'deposits',
    'withdrawals',
    'prop_firm_sales',
    'p2p_transfers',
    -- expenses
    'expenses',
    'preoperative_expenses',
    -- balances & income
    'operating_income',
    'broker_balance',
    'financial_status',
    -- partners
    'partners',
    'partner_distributions',
    -- modules
    'liquidity_movements',
    'investments',
    -- HR
    'employees',
    'commercial_profiles',
    'commercial_monthly_results',
    -- templates & snapshots
    'expense_templates',
    'channel_balances',
    'commercial_negotiations',
    'custom_roles',
    'pinned_coinsbuy_wallets'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_update', t);

    -- USING validates the row pre-update (must already belong to a company
    -- the caller can edit).
    -- WITH CHECK validates the row post-update (must STILL belong to a
    -- company the caller can edit — prevents cross-tenant pivot).
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (auth_can_edit(company_id)) WITH CHECK (auth_can_edit(company_id))',
      t || '_update', t
    );

    RAISE NOTICE 'Hardened UPDATE policy for table %', t;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. companies — special shape (uses id, not company_id)
-- ---------------------------------------------------------------------------
-- A superadmin or a member of the company can edit the row. WITH CHECK
-- guards against a non-superadmin member flipping `id` (effectively
-- renaming a tenant to an id they shouldn't own). `id` is a PRIMARY KEY
-- so this is mostly a belt-and-suspenders check, but keep it consistent.

DROP POLICY IF EXISTS "companies_update" ON companies;
CREATE POLICY "companies_update" ON companies
  FOR UPDATE
  USING (
    is_superadmin()
    OR id IN (SELECT auth_company_ids())
  )
  WITH CHECK (
    is_superadmin()
    OR id IN (SELECT auth_company_ids())
  );

-- ---------------------------------------------------------------------------
-- 3. company_users — special shape (auth_can_manage)
-- ---------------------------------------------------------------------------
-- Without WITH CHECK, an admin of A could UPDATE a membership to set
-- company_id=B, making the user a member of B without B's admin approving.

DROP POLICY IF EXISTS "company_users_update" ON company_users;
CREATE POLICY "company_users_update" ON company_users
  FOR UPDATE
  USING (auth_can_manage(company_id))
  WITH CHECK (auth_can_manage(company_id));

COMMIT;

-- =============================================================================
-- VERIFICATION — run as superuser to confirm WITH CHECK landed everywhere
-- =============================================================================
--
--   SELECT tablename, policyname, cmd, qual IS NOT NULL AS has_using,
--          with_check IS NOT NULL AS has_with_check
--   FROM pg_policies
--   WHERE cmd = 'UPDATE'
--     AND tablename IN (
--       'periods','deposits','withdrawals','prop_firm_sales','p2p_transfers',
--       'expenses','preoperative_expenses','operating_income','broker_balance',
--       'financial_status','partners','partner_distributions',
--       'liquidity_movements','investments','employees','commercial_profiles',
--       'commercial_monthly_results','expense_templates','channel_balances',
--       'commercial_negotiations','custom_roles','pinned_coinsbuy_wallets',
--       'companies','company_users'
--     )
--   ORDER BY tablename;
--
-- Expected: every row has has_using=true AND has_with_check=true.
-- =============================================================================
