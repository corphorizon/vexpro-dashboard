-- ─────────────────────────────────────────────────────────────────────────────
-- migration-045: RLS initplan + índices FK (Fase B2, 2026-06-20)
--
-- 1) 33 políticas RLS re-evaluaban auth.uid() / is_superadmin() /
--    auth_user_company_id() POR FILA (lint 0003 de Supabase). Envolverlas en
--    (select ...) las convierte en InitPlan: una evaluación por query.
--    Cambio semánticamente neutro — misma autorización, menos CPU.
-- 2) Índices para las 12 FKs sin cobertura (columnas de auditoría *_by).
-- ─────────────────────────────────────────────────────────────────────────────

DO $fix$
DECLARE
  p record;
  new_qual text;
  new_check text;
BEGIN
  FOR p IN
    SELECT * FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'companies','company_users','partner_distributions','audit_logs',
        'pinned_coinsbuy_wallets','custom_roles','risk_revisions',
        'channel_configs','report_configs','ib_rebate_config_history',
        'ib_rebate_thresholds','ib_rebate_configs','excluded_transactions'
      )
      AND (
        coalesce(qual,'') LIKE '%auth.uid()%' OR coalesce(with_check,'') LIKE '%auth.uid()%'
        OR coalesce(qual,'') ~ '\mis_superadmin\(\)' OR coalesce(with_check,'') ~ '\mis_superadmin\(\)'
        OR coalesce(qual,'') LIKE '%auth_user_company_id()%' OR coalesce(with_check,'') LIKE '%auth_user_company_id()%'
      )
  LOOP
    new_qual := p.qual;
    new_check := p.with_check;
    IF new_qual IS NOT NULL THEN
      new_qual := replace(new_qual, 'auth.uid()', '(select auth.uid())');
      new_qual := regexp_replace(new_qual, '\mis_superadmin\(\)', '(select is_superadmin())', 'g');
      new_qual := replace(new_qual, 'auth_user_company_id()', '(select auth_user_company_id())');
    END IF;
    IF new_check IS NOT NULL THEN
      new_check := replace(new_check, 'auth.uid()', '(select auth.uid())');
      new_check := regexp_replace(new_check, '\mis_superadmin\(\)', '(select is_superadmin())', 'g');
      new_check := replace(new_check, 'auth_user_company_id()', '(select auth_user_company_id())');
    END IF;

    IF new_qual IS NOT NULL AND new_check IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON public.%I USING (%s) WITH CHECK (%s)', p.policyname, p.tablename, new_qual, new_check);
    ELSIF new_qual IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON public.%I USING (%s)', p.policyname, p.tablename, new_qual);
    ELSIF new_check IS NOT NULL THEN
      EXECUTE format('ALTER POLICY %I ON public.%I WITH CHECK (%s)', p.policyname, p.tablename, new_check);
    END IF;
  END LOOP;
END
$fix$;

create index if not exists idx_api_credentials_updated_by on public.api_credentials (updated_by);
create index if not exists idx_commercial_profiles_terminated_by on public.commercial_profiles (terminated_by);
create index if not exists idx_companies_created_by on public.companies (created_by);
create index if not exists idx_custom_roles_created_by on public.custom_roles (created_by);
create index if not exists idx_excluded_transactions_excluded_by on public.excluded_transactions (excluded_by);
create index if not exists idx_ib_rebate_config_history_changed_by on public.ib_rebate_config_history (changed_by);
create index if not exists idx_ib_rebate_configs_created_by on public.ib_rebate_configs (created_by);
create index if not exists idx_ib_rebate_configs_updated_by on public.ib_rebate_configs (updated_by);
create index if not exists idx_ib_rebate_thresholds_updated_by on public.ib_rebate_thresholds (updated_by);
create index if not exists idx_platform_users_created_by on public.platform_users (created_by);
create index if not exists idx_report_configs_updated_by on public.report_configs (updated_by);
create index if not exists idx_risk_revisions_created_by on public.risk_revisions (created_by);
