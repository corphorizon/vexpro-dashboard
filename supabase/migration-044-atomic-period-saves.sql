-- ─────────────────────────────────────────────────────────────────────────────
-- migration-044: guardados atómicos para TODO lo que se persiste por período
-- (Fase A2 del plan de estabilización, 2026-06-20)
--
-- Mismo racional que migration-043 (replace_period_expenses): eliminar el
-- patrón "2 llamadas HTTP no transaccionales" (DELETE→INSERT o SELECT→
-- UPDATE/INSERT) que puede dejar el período vacío o corrupto si la segunda
-- llamada falla o time-outea. Aplica a: deposits, withdrawals (RPCs de
-- reemplazo) y prop_firm_sales / p2p_transfers (UNIQUE nuevos para permitir
-- upsert nativo ON CONFLICT de una sola llamada; operating_income y
-- channel_balances ya tenían su UNIQUE).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.prop_firm_sales
  add constraint prop_firm_sales_company_period_key unique (company_id, period_id);
alter table public.p2p_transfers
  add constraint p2p_transfers_company_period_key unique (company_id, period_id);

create or replace function public.replace_period_deposits(
  p_company_id uuid, p_period_id uuid, p_rows jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.auth_can_edit(p_company_id) then
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

create or replace function public.replace_period_withdrawals(
  p_company_id uuid, p_period_id uuid, p_rows jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.auth_can_edit(p_company_id) then
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

revoke all on function public.replace_period_deposits(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_period_deposits(uuid, uuid, jsonb) to authenticated;
revoke all on function public.replace_period_withdrawals(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_period_withdrawals(uuid, uuid, jsonb) to authenticated;
