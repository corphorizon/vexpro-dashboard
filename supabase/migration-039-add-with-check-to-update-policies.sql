-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 039 — Add WITH CHECK to UPDATE policies that were missing it
--
-- Audit (2026-05-01) found 5 UPDATE policies on tenant-scoped tables that
-- only set the USING clause (`qual`) but not WITH CHECK. PostgreSQL evaluates
-- USING against the row BEFORE the update, but without WITH CHECK there is
-- nothing stopping a row from being mutated INTO a state that no longer
-- belongs to the caller's tenant — e.g. updating `company_id` to point at
-- another tenant.
--
-- Fix: drop and recreate each policy with the same expression in both USING
-- and WITH CHECK. The 4 sibling tables (channel_balances, channel_configs,
-- ib_rebate_config_history, etc.) already had this pattern after migration
-- 027; this migration closes the residual gap.
--
-- Tables affected:
--   · channel_configs       → admin of company
--   · ib_rebate_configs     → company member OR superadmin
--   · ib_rebate_thresholds  → company member OR superadmin
--   · platform_users        → superadmin only
--   · report_configs        → admin of company
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. channel_configs ----------------------------------------------------------
DROP POLICY IF EXISTS channel_configs_update ON public.channel_configs;
CREATE POLICY channel_configs_update ON public.channel_configs
  FOR UPDATE
  USING (
    company_id IN (
      SELECT company_users.company_id
      FROM company_users
      WHERE company_users.user_id = auth.uid()
        AND company_users.role = 'admin'
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_users.company_id
      FROM company_users
      WHERE company_users.user_id = auth.uid()
        AND company_users.role = 'admin'
    )
  );

-- 2. ib_rebate_configs --------------------------------------------------------
DROP POLICY IF EXISTS ib_rebate_configs_update ON public.ib_rebate_configs;
CREATE POLICY ib_rebate_configs_update ON public.ib_rebate_configs
  FOR UPDATE
  USING (
    company_id IN (
      SELECT company_users.company_id
      FROM company_users
      WHERE company_users.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM platform_users WHERE platform_users.user_id = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_users.company_id
      FROM company_users
      WHERE company_users.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM platform_users WHERE platform_users.user_id = auth.uid()
    )
  );

-- 3. ib_rebate_thresholds -----------------------------------------------------
DROP POLICY IF EXISTS ib_rebate_thresholds_update ON public.ib_rebate_thresholds;
CREATE POLICY ib_rebate_thresholds_update ON public.ib_rebate_thresholds
  FOR UPDATE
  USING (
    company_id IN (
      SELECT company_users.company_id
      FROM company_users
      WHERE company_users.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM platform_users WHERE platform_users.user_id = auth.uid()
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_users.company_id
      FROM company_users
      WHERE company_users.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM platform_users WHERE platform_users.user_id = auth.uid()
    )
  );

-- 4. platform_users -----------------------------------------------------------
DROP POLICY IF EXISTS platform_users_update ON public.platform_users;
CREATE POLICY platform_users_update ON public.platform_users
  FOR UPDATE
  USING (is_superadmin())
  WITH CHECK (is_superadmin());

-- 5. report_configs -----------------------------------------------------------
DROP POLICY IF EXISTS report_configs_update ON public.report_configs;
CREATE POLICY report_configs_update ON public.report_configs
  FOR UPDATE
  USING (
    company_id IN (
      SELECT company_users.company_id
      FROM company_users
      WHERE company_users.user_id = auth.uid()
        AND company_users.role = 'admin'
    )
  )
  WITH CHECK (
    company_id IN (
      SELECT company_users.company_id
      FROM company_users
      WHERE company_users.user_id = auth.uid()
        AND company_users.role = 'admin'
    )
  );

-- Verification:
--   SELECT tablename, policyname, cmd, with_check
--   FROM pg_policies
--   WHERE policyname IN (
--     'channel_configs_update','ib_rebate_configs_update',
--     'ib_rebate_thresholds_update','platform_users_update',
--     'report_configs_update'
--   );
-- All five `with_check` columns must now be non-null.
