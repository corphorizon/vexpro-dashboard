-- ─────────────────────────────────────────────────────────────────────────────
-- migration-049: bypass de service_role en replace_period_deposits/withdrawals
--
-- TODAS las escrituras de datos se movieron a un dispatcher server-side
-- (/api/admin/data) porque escribir con el cliente supabase-js del browser se
-- cuelga de forma recurrente (auth-refresh se estanca). El dispatcher valida
-- auth con verifyAdminAuth y llama estos RPC con el admin client (service_role).
-- Sin bypass, auth_can_edit falla bajo service_role (auth.uid() null). Mismo
-- patrón que replace_period_expenses (migración 048).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.replace_period_deposits(p_company_id uuid, p_period_id uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'authenticated' and not public.auth_can_edit(p_company_id) then
    raise exception 'No autorizado para editar depósitos de esta empresa';
  end if;
  delete from public.deposits where company_id = p_company_id and period_id = p_period_id;
  if p_rows is not null and jsonb_array_length(p_rows) > 0 then
    insert into public.deposits (company_id, period_id, channel, amount)
    select p_company_id, p_period_id, r->>'channel', (r->>'amount')::numeric
    from jsonb_array_elements(p_rows) as r
    where coalesce((r->>'amount')::numeric, 0) > 0;
  end if;
end; $$;

create or replace function public.replace_period_withdrawals(p_company_id uuid, p_period_id uuid, p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() = 'authenticated' and not public.auth_can_edit(p_company_id) then
    raise exception 'No autorizado para editar retiros de esta empresa';
  end if;
  delete from public.withdrawals where company_id = p_company_id and period_id = p_period_id;
  if p_rows is not null and jsonb_array_length(p_rows) > 0 then
    insert into public.withdrawals (company_id, period_id, category, amount, description)
    select p_company_id, p_period_id, r->>'category', (r->>'amount')::numeric, nullif(r->>'description','')
    from jsonb_array_elements(p_rows) as r
    where coalesce((r->>'amount')::numeric, 0) > 0;
  end if;
end; $$;
