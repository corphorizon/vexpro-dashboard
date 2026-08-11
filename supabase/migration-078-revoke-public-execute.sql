-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 078 — Revocar EXECUTE de PUBLIC (la causa raíz que anuló 051/076/077)
--
-- Hallazgo: las migraciones 051, 076 y 077 revocaban EXECUTE de `anon` y
-- `authenticated`, pero esos roles heredan el grant de PUBLIC que Postgres pone
-- por defecto al crear una función (`CREATE FUNCTION` → `GRANT EXECUTE TO PUBLIC`).
-- Revocar de anon/authenticated NO quita el grant de PUBLIC, así que
-- has_function_privilege('anon', ...) seguía devolviendo true. En el ACL se ve
-- como `=X/postgres` (grantee vacío = PUBLIC).
--
-- `close_period` mostraba false justamente porque a ella SÍ le habían revocado
-- PUBLIC en su momento; las demás no. Esta migración lo unifica.
--
-- Fix correcto: REVOKE ... FROM PUBLIC, y volver a conceder a `authenticated`
-- los helpers de auth que las policies de RLS evalúan con el rol del consultante
-- (sin ellos, RLS rompe para todo usuario logueado). El service_role conserva su
-- grant explícito en todas y no pasa por estos grants de todos modos.
--
-- Idempotente.
-- ─────────────────────────────────────────────────────────────────────────────

-- Server-only (solo service role las invoca): quitar PUBLIC por completo.
revoke execute on function public.get_period_totals_by_month(uuid, timestamptz, timestamptz) from public;
revoke execute on function public.next_payment_order_number(uuid) from public;
revoke execute on function public.rls_auto_enable() from public;

-- Helpers de auth: quitar PUBLIC (cierra anon) pero garantizar authenticated.
revoke execute on function public.is_superadmin() from public;
revoke execute on function public.auth_company_ids() from public;
revoke execute on function public.auth_user_company_id() from public;
revoke execute on function public.auth_user_role() from public;
revoke execute on function public.auth_user_role(uuid) from public;
revoke execute on function public.auth_can_edit(uuid) from public;
revoke execute on function public.auth_can_manage(uuid) from public;

grant execute on function public.is_superadmin() to authenticated;
grant execute on function public.auth_company_ids() to authenticated;
grant execute on function public.auth_user_company_id() to authenticated;
grant execute on function public.auth_user_role() to authenticated;
grant execute on function public.auth_user_role(uuid) to authenticated;
grant execute on function public.auth_can_edit(uuid) to authenticated;
grant execute on function public.auth_can_manage(uuid) to authenticated;
