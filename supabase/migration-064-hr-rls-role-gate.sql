-- Migración 064 — Los datos de RRHH dejan de ser visibles para toda la empresa
-- (APLICADA a producción el 2026-08-06 — auditoría, hallazgo S1 crítico.)
--
-- Las políticas SELECT de employees y commercial_profiles solo filtraban por
-- empresa, no por rol, y el data-context las cargaba al arrancar PARA TODOS:
-- un `invitado` sin el módulo RRHH veía sueldos, motivos de despido y
-- contratos con abrir la pestaña Network.
--
-- Políticas RESTRICTIVAS (AND con las permisivas existentes, sin depender de
-- sus nombres): solo admin, hr y superadmin leen estas cuatro tablas. El
-- service role no pasa por RLS, así que los endpoints (gateados por
-- HR_ROLES) siguen funcionando.

create or replace function public.auth_is_hr_reader()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.company_users cu
     where cu.user_id = auth.uid() and cu.role in ('admin', 'hr')
  )
  or exists (
    select 1 from public.platform_users pu where pu.user_id = auth.uid()
  );
$$;

revoke all on function public.auth_is_hr_reader() from public, anon;
grant execute on function public.auth_is_hr_reader() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['employees','commercial_profiles','commercial_monthly_results','commercial_negotiations']
  loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('drop policy if exists %I_hr_role_gate on public.%I', t, t);
      execute format(
        'create policy %I_hr_role_gate on public.%I as restrictive for select to authenticated using (public.auth_is_hr_reader())',
        t, t);
    end if;
  end loop;
end $$;
