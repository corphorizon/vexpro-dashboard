-- Migración 068 — Ingresos operativos con detalle por concepto
--
-- POR QUÉ
-- `operating_income` guarda TRES números por período (prop_firm, broker_pnl,
-- other). Para un broker alcanza. Para una consultora como Horizon no: su
-- contabilidad son 3 a 12 facturas por mes, cada una con cliente, monto,
-- cobrado y pendiente. Migrar su planilla sin esto tiraría a la basura los
-- $40.136 por cobrar y el detalle de quién los debe — que es justamente lo
-- que esa planilla hace mejor que el dashboard.
--
-- Es el espejo exacto de `expenses` (concepto/monto/pagado/pendiente), y a
-- propósito: el equipo ya sabe operar esa tabla.
--
-- LA DECISIÓN QUE IMPORTA: el total sigue viviendo en operating_income.other
-- ---------------------------------------------------------------------------
-- La fórmula de distribución NO se toca. Las líneas son el detalle y su total
-- se materializa en `operating_income.other` dentro de la MISMA transacción
-- que las escribe (ver replace_income_lines). Así:
--   · la cadena de socios, el forecast y el cierre siguen leyendo lo mismo
--     que hoy — cero riesgo para Vex Pro y AP Markets, que no usan líneas;
--   · no hay dos fuentes de verdad: el total es SIEMPRE derivado, nunca se
--     edita por separado cuando hay líneas.
--
-- Se materializa lo COBRADO, no lo facturado. La cadena reparte caja: una
-- factura emitida y no cobrada no es plata que exista para distribuir. El
-- pendiente queda a la vista como cuentas por cobrar, que es su lugar.

create table if not exists public.income_lines (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  period_id   uuid not null references public.periods(id) on delete cascade,
  concept     text not null,
  /** Quién paga. Separado del concepto para poder agrupar por cliente. */
  client      text,
  amount      numeric(14,2) not null default 0,
  received    numeric(14,2) not null default 0,
  pending     numeric(14,2) not null default 0,
  category    text,
  reference   text,
  income_date date,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists income_lines_period_idx
  on public.income_lines (company_id, period_id, sort_order);

alter table public.income_lines enable row level security;

-- Mismas políticas que expenses: la aislación por empresa la da la membresía.
drop policy if exists income_lines_select on public.income_lines;
create policy income_lines_select on public.income_lines
  for select using (
    company_id in (select company_id from public.company_users where user_id = (select auth.uid()))
  );

drop policy if exists income_lines_write on public.income_lines;
create policy income_lines_write on public.income_lines
  for all using (
    company_id in (
      select company_id from public.company_users
      where user_id = (select auth.uid()) and role in ('admin', 'auditor')
    )
  );

-- Un período cerrado congela también sus ingresos.
drop trigger if exists trg_guard_closed_period on public.income_lines;
create trigger trg_guard_closed_period
  before insert or update or delete on public.income_lines
  for each row execute function public.guard_closed_period();

-- ---------------------------------------------------------------------------
-- Reemplazo atómico del período + materialización del total.
--
-- Borra e inserta (mismo patrón que replace_period_expenses) y deja
-- operating_income.other en la suma de lo COBRADO. Las dos cosas en la misma
-- transacción: si se separaran, un fallo entre medio dejaría el detalle y el
-- total contando cosas distintas, y la cadena de socios repartiría sobre un
-- número que ninguna pantalla muestra.
-- ---------------------------------------------------------------------------
create or replace function public.replace_income_lines(
  p_company_id uuid,
  p_period_id  uuid,
  p_lines      jsonb
) returns numeric language plpgsql set search_path = public as $$
declare
  v_received numeric(14,2);
begin
  delete from public.income_lines
   where company_id = p_company_id and period_id = p_period_id;

  insert into public.income_lines (
    company_id, period_id, concept, client, amount, received, pending,
    category, reference, income_date, sort_order
  )
  select p_company_id, p_period_id,
         coalesce(r->>'concept', ''),
         nullif(r->>'client', ''),
         coalesce((r->>'amount')::numeric, 0),
         coalesce((r->>'received')::numeric, 0),
         coalesce((r->>'pending')::numeric, 0),
         nullif(r->>'category', ''),
         nullif(r->>'reference', ''),
         nullif(r->>'income_date', '')::date,
         coalesce((r->>'sort_order')::int, 0)
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as r
   where coalesce(r->>'concept', '') <> '';

  select coalesce(sum(received), 0) into v_received
    from public.income_lines
   where company_id = p_company_id and period_id = p_period_id;

  -- El período puede no tener fila de ingresos todavía.
  insert into public.operating_income (company_id, period_id, other)
  values (p_company_id, p_period_id, v_received)
  on conflict (company_id, period_id)
    do update set other = excluded.other, updated_at = now();

  return v_received;
end; $$;

comment on table public.income_lines is
  'Detalle de ingresos operativos por concepto. El total COBRADO se materializa en operating_income.other vía replace_income_lines; no se edita por separado.';
