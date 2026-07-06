-- ─────────────────────────────────────────────────────────────────────────────
-- migration-046: materializar egresos fijos en períodos nuevos (2026-06-20)
--
-- PROBLEMA: los egresos marcados como "Fijo" (plantillas en expense_templates)
-- solo existían como PREVIEW en /upload — había que abrir esa pantalla y
-- guardar para que se persistieran. En un mes recién creado por el cron, el
-- período salía VACÍO en /egresos, reportes y socios hasta que alguien lo
-- guardaba a mano. Kevin: "en julio no aparecen los egresos marcados como fijos".
--
-- FIX: función idempotente que inserta las plantillas ACTIVAS como filas reales
-- en un período (si aún no tiene egresos). Hereda la categoría del egreso más
-- reciente con el mismo concepto (misma lógica que el preview de /upload).
-- El cron create-new-period la llama al abrir cada período nuevo.
--
-- Auth: 'authenticated' pasa por auth_can_edit; service_role (cron) y postgres
-- omiten el check. EXECUTE revocado a anon.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.materialize_fixed_expenses(
  p_company_id uuid,
  p_period_id uuid
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  if auth.role() = 'authenticated' and not public.auth_can_edit(p_company_id) then
    raise exception 'No autorizado para editar egresos de esta empresa';
  end if;

  -- Idempotente: no tocar un período que ya tiene egresos.
  if exists (
    select 1 from public.expenses
    where company_id = p_company_id and period_id = p_period_id
  ) then
    return 0;
  end if;

  with tmpl as (
    select concept, amount,
           row_number() over (order by concept) as rn
    from public.expense_templates
    where company_id = p_company_id and active = true
  ),
  latest_cat as (
    select distinct on (e.concept) e.concept, e.category
    from public.expenses e
    join public.periods p on p.id = e.period_id
    where e.company_id = p_company_id
    order by e.concept, p.year desc, p.month desc
  )
  insert into public.expenses
    (company_id, period_id, concept, amount, paid, pending, is_fixed, category, sort_order, created_at, updated_at)
  select p_company_id, p_period_id, t.concept, t.amount, 0, t.amount, true, lc.category, t.rn, now(), now()
  from tmpl t
  left join latest_cat lc on lc.concept = t.concept;

  get diagnostics v_count = row_count;
  return v_count;
end; $$;

revoke all on function public.materialize_fixed_expenses(uuid, uuid) from public, anon;
grant execute on function public.materialize_fixed_expenses(uuid, uuid) to authenticated, service_role;
