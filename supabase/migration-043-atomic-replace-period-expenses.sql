-- ─────────────────────────────────────────────────────────────────────────────
-- migration-043: reemplazo ATÓMICO de egresos de un período
--
-- PROBLEMA (causó el vaciado de VexPro May 2026, 2026-06-20):
--   upsertExpenses() en el cliente hacía DELETE de todas las filas del período
--   y luego INSERT, en DOS llamadas HTTP separadas (no transaccional). Si el
--   INSERT fallaba, time-outeaba (el timeout de egresos que Kevin reportó), o se
--   cortaba la red tras un DELETE exitoso, el período quedaba con 0 egresos.
--   Combinado con el autosave, cualquier guardado lento podía borrar todo.
--
-- FIX:
--   Una función plpgsql corre en UNA sola transacción. Si el INSERT lanza, el
--   DELETE se revierte automáticamente. El período nunca queda en estado vacío
--   por un fallo a mitad: o se guarda completo, o no se toca nada.
--
-- SEGURIDAD:
--   SECURITY DEFINER + check interno auth_can_edit(p_company_id) — mismo patrón
--   que el resto de RPCs del proyecto. RLS se evalúa vía auth_can_edit (cubre
--   superadmin "viewing-as"). EXECUTE solo para `authenticated`, revocado a anon.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.replace_period_expenses(
  p_company_id uuid,
  p_period_id uuid,
  p_rows jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.auth_can_edit(p_company_id) then
    raise exception 'No autorizado para editar egresos de esta empresa';
  end if;

  delete from public.expenses
  where company_id = p_company_id and period_id = p_period_id;

  if p_rows is not null and jsonb_array_length(p_rows) > 0 then
    insert into public.expenses
      (company_id, period_id, concept, amount, paid, pending, is_fixed, category, sort_order, created_at, updated_at)
    select
      p_company_id,
      p_period_id,
      r->>'concept',
      coalesce((r->>'amount')::numeric, 0),
      coalesce((r->>'paid')::numeric, 0),
      coalesce((r->>'pending')::numeric, 0),
      coalesce((r->>'is_fixed')::boolean, false),
      nullif(r->>'category', ''),
      idx::int,
      now(),
      now()
    from jsonb_array_elements(p_rows) with ordinality as t(r, idx);
  end if;
end;
$$;

revoke all on function public.replace_period_expenses(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_period_expenses(uuid, uuid, jsonb) to authenticated;
