-- ─────────────────────────────────────────────────────────────────────────────
-- migration-048: replace_period_expenses — bypass de service_role (2026-07-13)
--
-- El guardado de egresos se movió a un endpoint server-side
-- (/api/admin/expenses) porque el cliente supabase-js del browser se colgaba
-- >12s de forma recurrente (refresh del token de auth se estancaba en
-- navigator.locks/red), aunque la DB responde el DELETE+INSERT en ~9ms. El
-- route valida auth con verifyAdminAuth (company_id del JWT) y llama la RPC con
-- el admin client (service_role).
--
-- Sin este cambio, auth_can_edit(company) falla bajo service_role (auth.uid()
-- es null). Bypass: solo 'authenticated' (llamada directa del browser, si
-- quedara alguna) pasa por auth_can_edit; el service_role lo omite (el route
-- ya validó al admin). Mismo patrón que materialize_fixed_expenses.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.replace_period_expenses(
  p_company_id uuid, p_period_id uuid, p_rows jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'authenticated' and not public.auth_can_edit(p_company_id) then
    raise exception 'No autorizado para editar egresos de esta empresa';
  end if;

  delete from public.expenses
  where company_id = p_company_id and period_id = p_period_id;

  if p_rows is not null and jsonb_array_length(p_rows) > 0 then
    insert into public.expenses
      (company_id, period_id, concept, amount, paid, pending, is_fixed, category, sort_order, created_at, updated_at)
    select
      p_company_id, p_period_id,
      r->>'concept',
      coalesce((r->>'amount')::numeric, 0),
      coalesce((r->>'paid')::numeric, 0),
      coalesce((r->>'pending')::numeric, 0),
      coalesce((r->>'is_fixed')::boolean, false),
      nullif(r->>'category', ''),
      idx::int, now(), now()
    from jsonb_array_elements(p_rows) with ordinality as t(r, idx);
  end if;
end; $$;
