-- Migración 066 — guard_closed_period cubre lo que faltaba (defensa en profundidad)
--
-- Desde el snapshot-en-cadena (2026-08-07) la fórmula YA no le cree a las
-- tablas vivas de un mes cerrado: lee closing_snapshot y el drift se ve en
-- /socios. Este guard es la segunda capa: que el pasado tampoco se pueda
-- EDITAR por abajo, se vea o no.
--
--   · investments — no tiene period_id: se resuelve el período por
--     company_id + mes de `date` (misma regla que usa close_period para
--     congelar investment_profits). Se chequea el lado NUEVO y el VIEJO:
--     mover una inversión hacia/desde un mes cerrado también está bloqueado.
--   · p2p_transfers — tiene period_id: entra al trigger genérico existente.
--   · periods.reserve_pct — insumo de la fórmula: no se cambia con el
--     período cerrado (cerrar/reabrir sí pasan, porque is_closed cambia).
--
-- FUERA A PROPÓSITO: partner_distributions. La distribución se guarda
-- DESPUÉS de cerrar el mes (ese es el flujo), y borrar un socio limpia sus
-- filas históricas — bloquearlo rompería ambos. La inmutabilidad de los
-- montos la da el snapshot, no esa tabla.
--
-- errcode check_violation en todos: friendlyDbMessage ya deja pasar ese
-- mensaje al usuario tal cual.

-- ── investments: período por fecha ──────────────────────────────────────────
create or replace function public.guard_closed_period_by_date()
returns trigger language plpgsql set search_path = public as $$
declare
  v_closed boolean;
begin
  if tg_op <> 'DELETE' then
    select is_closed into v_closed from public.periods
     where company_id = new.company_id
       and year  = extract(year  from new.date)::int
       and month = extract(month from new.date)::int;
    if coalesce(v_closed, false) then
      raise exception 'El periodo del %-% esta cerrado: no se puede modificar %. Reabrilo o registra la correccion en el periodo abierto.',
        extract(month from new.date)::int, extract(year from new.date)::int, tg_table_name
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op <> 'INSERT' then
    select is_closed into v_closed from public.periods
     where company_id = old.company_id
       and year  = extract(year  from old.date)::int
       and month = extract(month from old.date)::int;
    if coalesce(v_closed, false) then
      raise exception 'El periodo del %-% esta cerrado: no se puede modificar ni mover esta fila de %.',
        extract(month from old.date)::int, extract(year from old.date)::int, tg_table_name
        using errcode = 'check_violation';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end; $$;

drop trigger if exists trg_guard_closed_period on public.investments;
create trigger trg_guard_closed_period
  before insert or update or delete on public.investments
  for each row execute function public.guard_closed_period_by_date();

-- ── p2p_transfers: tiene period_id, entra al guard genérico ─────────────────
drop trigger if exists trg_guard_closed_period on public.p2p_transfers;
create trigger trg_guard_closed_period
  before insert or update or delete on public.p2p_transfers
  for each row execute function public.guard_closed_period();

-- ── periods.reserve_pct: insumo congelado con el cierre ─────────────────────
create or replace function public.guard_closed_period_inputs()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.is_closed and new.is_closed
     and new.reserve_pct is distinct from old.reserve_pct then
    raise exception 'El periodo % esta cerrado: la reserva quedo congelada en el cierre. Reabrilo con motivo para cambiarla.', old.label
      using errcode = 'check_violation';
  end if;
  return new;
end; $$;

drop trigger if exists trg_guard_closed_period_inputs on public.periods;
create trigger trg_guard_closed_period_inputs
  before update on public.periods
  for each row execute function public.guard_closed_period_inputs();
