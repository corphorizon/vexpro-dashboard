-- ─────────────────────────────────────────────────────────────────────────────
-- migration-050: temporalidad de egresos fijos (2026-07-15)
--
-- Kevin: dos cambios de comportamiento en las plantillas de egresos fijos:
--
--   1. AGREGAR aplica "desde el mes actual en adelante" — una plantilla nueva
--      NO debe materializarse en meses anteriores a su creación. Antes, como
--      no había dimensión temporal, cualquier período vacío (incluido uno
--      pasado) recibía todas las plantillas activas.
--
--   2. OCULTAR es "por mes individual" — poder esconder una plantilla en julio
--      sin afectar junio ni agosto. Antes el flag `active` era global y solo
--      controlaba la materialización futura; no había forma de saltarse un
--      mes puntual.
--
-- Diseño:
--   · expense_templates.effective_from_year/month → primer mes en que aplica.
--     NULL = "siempre" (retro-compat: las plantillas existentes siguen
--     aplicando a todos los períodos como antes).
--   · expense_template_period_hidden(template_id, period_id) → la PRESENCIA de
--     una fila significa "esta plantilla está oculta en este período". Governa
--     tanto la materialización como el preview de /upload.
--   · materialize_fixed_expenses respeta ambos: solo materializa plantillas
--     activas cuya vigencia alcanza el período Y que no estén ocultas ahí.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Vigencia en las plantillas ──
alter table public.expense_templates
  add column if not exists effective_from_year  int,
  add column if not exists effective_from_month int;

comment on column public.expense_templates.effective_from_year is
  'Primer año en que la plantilla aplica. NULL = siempre (retro-compat).';
comment on column public.expense_templates.effective_from_month is
  'Primer mes (1-12) en que la plantilla aplica. NULL = siempre.';

-- ── 2. Ocultamiento por período ──
create table if not exists public.expense_template_period_hidden (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id)        on delete cascade,
  template_id uuid not null references public.expense_templates(id) on delete cascade,
  period_id   uuid not null references public.periods(id)          on delete cascade,
  created_at  timestamptz not null default now(),
  unique (template_id, period_id)
);

create index if not exists idx_etph_company_id on public.expense_template_period_hidden(company_id);
create index if not exists idx_etph_period_id  on public.expense_template_period_hidden(period_id);
create index if not exists idx_etph_template_id on public.expense_template_period_hidden(template_id);

alter table public.expense_template_period_hidden enable row level security;

-- Policies: mismo patrón company-scoped que expense_templates.
drop policy if exists "etph_select" on public.expense_template_period_hidden;
create policy "etph_select" on public.expense_template_period_hidden
  for select using (company_id in (select auth_company_ids()));

drop policy if exists "etph_insert" on public.expense_template_period_hidden;
create policy "etph_insert" on public.expense_template_period_hidden
  for insert with check (public.auth_can_edit(company_id));

drop policy if exists "etph_update" on public.expense_template_period_hidden;
create policy "etph_update" on public.expense_template_period_hidden
  for update using (public.auth_can_edit(company_id))
  with check (public.auth_can_edit(company_id));

drop policy if exists "etph_delete" on public.expense_template_period_hidden;
create policy "etph_delete" on public.expense_template_period_hidden
  for delete using (public.auth_can_edit(company_id));

-- ── 3. materialize_fixed_expenses respeta vigencia + ocultamiento ──
create or replace function public.materialize_fixed_expenses(
  p_company_id uuid,
  p_period_id uuid
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
  v_year  int;
  v_month int;
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

  -- Año/mes del período destino, para evaluar la vigencia de cada plantilla.
  select year, month into v_year, v_month
  from public.periods
  where id = p_period_id and company_id = p_company_id;

  if v_year is null then
    return 0; -- período inexistente o de otra empresa
  end if;

  with tmpl as (
    select t.id, t.concept, t.amount,
           row_number() over (order by t.concept) as rn
    from public.expense_templates t
    where t.company_id = p_company_id
      and t.active = true
      -- Vigencia: NULL = siempre; si tiene fecha, el período debe ser >= a ella.
      and (
        t.effective_from_year is null
        or (v_year > t.effective_from_year)
        or (v_year = t.effective_from_year and v_month >= coalesce(t.effective_from_month, 1))
      )
      -- No materializar plantillas ocultas para este período.
      and not exists (
        select 1 from public.expense_template_period_hidden h
        where h.template_id = t.id and h.period_id = p_period_id
      )
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

revoke execute on function public.materialize_fixed_expenses(uuid, uuid) from anon;
