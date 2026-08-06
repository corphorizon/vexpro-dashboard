-- Migración 061 — Cierre real de períodos (lock + RPCs)
-- (Recuperada del historial de Supabase el 2026-08-06: se aplicó vía MCP en
--  dos partes — period_close_lock y period_close_rpcs — y el archivo nunca se
--  commiteó. Auditoría A5: sin esto, un entorno nuevo no tiene ni el trigger
--  de bloqueo ni las RPCs de cierre, y `close_period` daría 404.)
--
-- 1. CONGELA los totales (INSUMOS de la cadena, no el resultado — la fórmula
--    vive solo en src/lib/distribution.ts) en periods.closing_snapshot.
-- 2. BLOQUEA escrituras vía trigger guard_closed_period sobre expenses,
--    deposits, withdrawals, operating_income y prop_firm_sales. Mira el
--    period_id nuevo Y el viejo (mover una fila también está bloqueado).
-- 3. Reabrir exige motivo y queda en audit_logs.
--
-- HUECOS CONOCIDOS (auditoría 2026-08-06, pendientes de la tanda B):
--   · investments (date-keyed), p2p_transfers, partner_distributions y
--     periods.reserve_pct NO están cubiertos por el guard.
--   · El snapshot todavía no se LEE — la cadena sigue recalculando en vivo.

alter table public.periods
  add column if not exists closed_at        timestamptz,
  add column if not exists closed_by        uuid references auth.users(id),
  add column if not exists closed_by_name   text,
  add column if not exists closing_snapshot jsonb;

create or replace function public.period_is_closed(p_period_id uuid)
returns boolean language sql stable set search_path = public as $$
  select coalesce((select is_closed from public.periods where id = p_period_id), false);
$$;

create or replace function public.guard_closed_period()
returns trigger language plpgsql set search_path = public as $$
declare
  v_period uuid;
begin
  v_period := case when tg_op = 'DELETE' then old.period_id else new.period_id end;
  if v_period is not null and public.period_is_closed(v_period) then
    raise exception 'El periodo esta cerrado: no se puede modificar %. Reabrilo o registra la correccion en el periodo abierto.', tg_table_name
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' and old.period_id is distinct from new.period_id
     and public.period_is_closed(old.period_id) then
    raise exception 'El periodo de origen esta cerrado: no se puede mover esta fila.'
      using errcode = 'check_violation';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end; $$;

do $$
declare t text;
begin
  foreach t in array array['expenses','deposits','withdrawals','operating_income','prop_firm_sales']
  loop
    execute format('drop trigger if exists trg_guard_closed_period on public.%I', t);
    execute format(
      'create trigger trg_guard_closed_period before insert or update or delete on public.%I
         for each row execute function public.guard_closed_period()', t);
  end loop;
end $$;

create or replace function public.close_period(
  p_company_id uuid, p_period_id uuid, p_actor_id uuid, p_actor_name text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_period   record;
  v_snapshot jsonb;
begin
  select * into v_period from public.periods
   where id = p_period_id and company_id = p_company_id;
  if not found then raise exception 'Periodo no encontrado'; end if;
  if v_period.is_closed then
    raise exception 'El periodo % ya esta cerrado', v_period.label;
  end if;

  select jsonb_build_object(
    'period_label', v_period.label,
    'year',  v_period.year,
    'month', v_period.month,
    'reserve_pct', coalesce(v_period.reserve_pct, 0),
    'broker_pnl', coalesce((select broker_pnl from public.operating_income
                             where period_id = p_period_id limit 1), 0),
    'other_income', coalesce((select other from public.operating_income
                               where period_id = p_period_id limit 1), 0),
    'prop_firm_sales', coalesce((select sum(amount) from public.prop_firm_sales
                                  where period_id = p_period_id), 0),
    'prop_firm_withdrawals', coalesce((select sum(amount) from public.withdrawals
                                        where period_id = p_period_id
                                          and category = 'prop_firm'), 0),
    'investment_profits', coalesce((select sum(profit) from public.investments
                                     where company_id = p_company_id
                                       and extract(year  from date)::int = v_period.year
                                       and extract(month from date)::int = v_period.month), 0),
    'total_expenses', coalesce((select sum(amount) from public.expenses
                                 where period_id = p_period_id), 0),
    'total_deposits', coalesce((select sum(amount) from public.deposits
                                 where period_id = p_period_id), 0),
    'total_withdrawals', coalesce((select sum(amount) from public.withdrawals
                                    where period_id = p_period_id), 0),
    'frozen_at', now()
  ) into v_snapshot;

  update public.periods
     set is_closed = true, closed_at = now(), closed_by = p_actor_id,
         closed_by_name = p_actor_name, closing_snapshot = v_snapshot,
         updated_at = now()
   where id = p_period_id;

  insert into public.audit_logs (company_id, user_id, user_name, action, module, details)
  values (p_company_id, p_actor_id::text, p_actor_name, 'update', 'periods',
          'Periodo ' || v_period.label || ' CERRADO — totales congelados');

  return v_snapshot;
end; $$;

create or replace function public.reopen_period(
  p_company_id uuid, p_period_id uuid, p_actor_id uuid, p_actor_name text, p_reason text
) returns void language plpgsql security definer set search_path = public as $$
declare v_period record;
begin
  select * into v_period from public.periods
   where id = p_period_id and company_id = p_company_id;
  if not found then raise exception 'Periodo no encontrado'; end if;
  if not v_period.is_closed then
    raise exception 'El periodo % no esta cerrado', v_period.label;
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Reabrir un periodo cerrado requiere un motivo';
  end if;

  update public.periods set is_closed = false, updated_at = now()
   where id = p_period_id;

  insert into public.audit_logs (company_id, user_id, user_name, action, module, details)
  values (p_company_id, p_actor_id::text, p_actor_name, 'update', 'periods',
          'Periodo ' || v_period.label || ' REABIERTO — motivo: ' || p_reason);
end; $$;

revoke all on function public.close_period(uuid, uuid, uuid, text) from public, anon;
revoke all on function public.reopen_period(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function public.close_period(uuid, uuid, uuid, text) to service_role;
grant execute on function public.reopen_period(uuid, uuid, uuid, text, text) to service_role;
