-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 077 — Re-aplicar el lockdown de RPCs + endurecer audit_logs
--
-- Contexto (auditoría 2026-08-11): la migración 076 revocó EXECUTE sobre seis
-- funciones SECURITY DEFINER server-only, pero en PROD dos quedaron abiertas a
-- anon/authenticated —`get_period_totals_by_month` y `next_payment_order_number`—
-- porque fueron recreadas con DROP+CREATE después del revoke (lo que resetea los
-- grants a PUBLIC EXECUTE). Lo mismo les pasó a los helpers de auth de la migr.
-- 051 y a `next_payment_order_number` de la 054.
--
-- Efecto de la fuga: `get_period_totals_by_month` es DEFINER, recibe company_id
-- por parámetro y no tiene guard interno → cualquiera con la anon key pública
-- (que viaja en el bundle) podía leer depósitos/retiros mensuales de CUALQUIER
-- empresa vía POST /rest/v1/rpc/*. Fuga cross-tenant de la métrica más sensible.
--
-- LECCIÓN: un REVOKE en una migración NO es duradero si alguien hace luego un
-- DROP FUNCTION. La defensa real es un test de CI que verifique
-- has_function_privilege('anon', ...) sobre la lista de RPCs server-only (se
-- agrega en la tanda de código, no acá).
--
-- Idempotente: REVOKE es naturalmente idempotente; las policies usan DROP IF EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. RPCs server-only: cerrar a anon Y authenticated (se llaman solo con service
--    role; el service role no pasa por estos grants).
revoke execute on function public.get_period_totals_by_month(uuid, timestamptz, timestamptz) from anon, authenticated;
revoke execute on function public.next_payment_order_number(uuid) from anon, authenticated;

-- 2. Helpers de auth: cerrar SOLO a anon. `authenticated` DEBE conservar EXECUTE
--    porque las policies de RLS los evalúan con el rol del consultante; sin
--    sesión devuelven false/conjunto vacío, así que a anon no le sirven de nada.
revoke execute on function public.is_superadmin() from anon;
revoke execute on function public.auth_company_ids() from anon;
revoke execute on function public.auth_user_company_id() from anon;
revoke execute on function public.auth_user_role() from anon;
revoke execute on function public.auth_user_role(uuid) from anon;
revoke execute on function public.auth_can_edit(uuid) from anon;
revoke execute on function public.auth_can_manage(uuid) from anon;

-- 3. Función de event trigger: no debe ser invocable por REST por nadie.
revoke execute on function public.rls_auto_enable() from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. audit_logs — INSERT falsificable. El WITH CHECK solo exigía sesión, así que
--    un authenticated podía insertar entradas atribuidas a otra empresa u otro
--    usuario. Todas las escrituras legítimas van por service role (bypassea RLS),
--    así que endurecer no rompe nada: solo cierra el insert directo forjado.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy if exists audit_logs_insert on public.audit_logs;
create policy audit_logs_insert on public.audit_logs
  for insert to authenticated
  with check (
    -- audit_logs.user_id es text (no uuid); auth.uid() es uuid → cast explícito.
    user_id = (select auth.uid())::text
    and company_id in (select public.auth_company_ids())
  );

-- 5. audit_logs — SELECT: la tercera rama del OR dejaba las filas de plataforma
--    (company_id IS NULL: altas/bajas de usuarios, acciones de superadmin) a la
--    vista de CUALQUIER autenticado. Se reemplaza por is_superadmin().
drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (
    (select public.is_superadmin())
    or company_id in (
      select company_users.company_id from public.company_users
       where company_users.user_id = (select auth.uid())
         and company_users.role = any (array['admin','auditor'])
    )
  );
