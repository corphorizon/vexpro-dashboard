-- ─────────────────────────────────────────────────────────────────────────────
-- migration-051: hardening de la auditoría de seguridad 2026-08 (S3)
--
-- Corrige el drift migraciones↔prod detectado y verificado en la auditoría:
--
-- 1) pinned_coinsbuy_wallets tenía en prod 6 policies del rol {public}
--    (INSERT/UPDATE/DELETE incluidos) con DUPLICADOS (pinned_wallets_* +
--    pinned_coinsbuy_wallets_*), fuera de todo control de versiones. Se
--    eliminan TODAS y se recrean las 4 canónicas de migration-017, scoped a
--    `authenticated` (no a public/anon — la escritura real va por
--    /api/admin/data con service_role, que bypassa RLS igual).
--
-- 2) Funciones SECURITY DEFINER ejecutables por `anon` vía /rest/v1/rpc
--    (confirmado con aclexplode): se revoca EXECUTE a anon. `authenticated`
--    se conserva donde las RLS policies las usan (auth_*, is_superadmin);
--    get_period_totals_by_month queda solo para authenticated.
--
-- 3) Tablas de backup/purga: deny-all confirmado (RLS sin policy) — se les
--    revoca además todo privilegio directo a anon/authenticated por defensa
--    en profundidad.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. pinned_coinsbuy_wallets: borrar TODO y recrear canónico ──
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'pinned_coinsbuy_wallets'
  loop
    execute format('drop policy %I on public.pinned_coinsbuy_wallets', pol.policyname);
  end loop;
end $$;

create policy pinned_wallets_select on public.pinned_coinsbuy_wallets
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

create policy pinned_wallets_insert on public.pinned_coinsbuy_wallets
  for insert to authenticated
  with check (public.auth_can_edit(company_id));

create policy pinned_wallets_update on public.pinned_coinsbuy_wallets
  for update to authenticated
  using (public.auth_can_edit(company_id))
  with check (public.auth_can_edit(company_id));

create policy pinned_wallets_delete on public.pinned_coinsbuy_wallets
  for delete to authenticated
  using (public.auth_can_edit(company_id));

-- ── 2. Revocar EXECUTE a anon en SECURITY DEFINER expuestas ──
revoke execute on function public.is_superadmin() from anon;
revoke execute on function public.auth_company_ids() from anon;
revoke execute on function public.auth_user_company_id() from anon;
revoke execute on function public.auth_user_role() from anon;
revoke execute on function public.auth_user_role(uuid) from anon;
revoke execute on function public.auth_can_edit(uuid) from anon;
revoke execute on function public.auth_can_manage(uuid) from anon;
revoke execute on function public.get_period_totals_by_month(uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.rls_auto_enable() from anon;
revoke execute on function public.rls_auto_enable() from authenticated;

-- ── 3. Defensa en profundidad en tablas de backup/purga y auth-side ──
revoke all on table public.expenses_backup_20260606 from anon, authenticated;
revoke all on table public.api_transactions_cross_tenant_purge_20260606 from anon, authenticated;
revoke all on table public.channel_balances_cross_tenant_purge_20260715 from anon, authenticated;
revoke all on table public.channel_balances_savings_unpin_20260715 from anon, authenticated;
revoke all on table public.onboarding_checklist from anon, authenticated;
