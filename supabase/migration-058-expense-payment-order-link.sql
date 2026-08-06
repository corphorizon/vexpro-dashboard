-- Migración 058 — Vínculo egreso → orden de pago
-- (Recuperada del historial de Supabase el 2026-08-06. Auditoría A5.)
--
-- payment_orders.expense_id ya existía; esto agrega el sentido inverso para
-- que Egresos linkee al detalle de la orden sin depender del texto del
-- concepto. OJO: replace_period_expenses borra e inserta el período entero —
-- la columna DEBE viajar en el payload jsonb o se pierde al guardar el mes.

alter table expenses
  add column if not exists payment_order_id uuid references payment_orders(id) on delete set null;

create index if not exists idx_expenses_payment_order
  on expenses(payment_order_id) where payment_order_id is not null;

update expenses e
set payment_order_id = po.id
from payment_orders po
where po.expense_id = e.id
  and e.payment_order_id is null;

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
      (company_id, period_id, concept, amount, paid, pending, is_fixed, category,
       expense_date, payment_order_id, sort_order, created_at, updated_at)
    select
      p_company_id, p_period_id,
      r->>'concept',
      coalesce((r->>'amount')::numeric, 0),
      coalesce((r->>'paid')::numeric, 0),
      coalesce((r->>'pending')::numeric, 0),
      coalesce((r->>'is_fixed')::boolean, false),
      nullif(r->>'category', ''),
      nullif(r->>'expense_date', '')::date,
      nullif(r->>'payment_order_id', '')::uuid,
      idx::int, now(), now()
    from jsonb_array_elements(p_rows) with ordinality as t(r, idx);
  end if;
end; $$;

revoke all on function public.replace_period_expenses(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_period_expenses(uuid, uuid, jsonb) to authenticated;
-- NOTA: la migración 060 volvió a reemplazar esta RPC agregando reference y
-- attachment_* — este archivo refleja el estado intermedio (histórico).
