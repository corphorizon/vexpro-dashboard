-- ─────────────────────────────────────────────────────────────────────────────
-- migration-056: fecha opcional en los egresos (2026-08-06)
--
-- Kevin: "que los egresos dejen poner fecha".
--
-- Hasta ahora un egreso solo tenía la dimensión del PERÍODO (año/mes). Para
-- conciliar contra comprobantes hace falta poder anotar el día exacto de
-- pago/vencimiento sin cambiar el mes al que imputa.
--
-- Diseño:
--   · expenses.expense_date date NULL.
--   · NULL = "sin fecha específica, cuenta para el mes del período" — que es
--     exactamente el comportamiento actual, así que las filas existentes no
--     cambian de significado ni hace falta backfill. NUNCA se rellena con una
--     fecha inventada (p.ej. el día 1 del período): eso sería dato falso.
--   · La fecha es informativa; ningún cálculo agrega por ella. Los totales del
--     período se siguen calculando por period_id.
--
-- IMPORTANTE — replace_period_expenses:
--   El guardado de egresos (POST /api/admin/expenses) llama a esta RPC, que
--   BORRA todas las filas del período y las re-inserta desde el payload jsonb.
--   Cualquier columna que no se lea del jsonb se pierde en el siguiente
--   guardado. Por eso la función se redefine acá con `(r->>'expense_date')::date`
--   añadido. El resto del cuerpo es VERBATIM la definición que hoy está viva en
--   la base (verificada con pg_get_functiondef, idéntica a migration-048).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. La columna ──
alter table public.expenses
  add column if not exists expense_date date;

comment on column public.expenses.expense_date is
  'Fecha específica del egreso (opcional). NULL = sin fecha, cuenta para el mes del período. Informativa: los totales siguen agregándose por period_id.';

-- ── 2. replace_period_expenses: propagar expense_date en el delete+insert ──
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
      (company_id, period_id, concept, amount, paid, pending, is_fixed, category, expense_date, sort_order, created_at, updated_at)
    select
      p_company_id, p_period_id,
      r->>'concept',
      coalesce((r->>'amount')::numeric, 0),
      coalesce((r->>'paid')::numeric, 0),
      coalesce((r->>'pending')::numeric, 0),
      coalesce((r->>'is_fixed')::boolean, false),
      nullif(r->>'category', ''),
      -- nullif('') primero: el cliente manda "" cuando el input de fecha está
      -- vacío y ''::date explota. Vacío ⇒ NULL, nunca una fecha inventada.
      nullif(r->>'expense_date', '')::date,
      idx::int, now(), now()
    from jsonb_array_elements(p_rows) with ordinality as t(r, idx);
  end if;
end; $$;

revoke all on function public.replace_period_expenses(uuid, uuid, jsonb) from public, anon;
grant execute on function public.replace_period_expenses(uuid, uuid, jsonb) to authenticated;
