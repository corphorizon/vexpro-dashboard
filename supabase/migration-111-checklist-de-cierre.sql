-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 111 — El checklist de cierre queda escrito · y no se cierra fuera
--                 de orden
--
-- SIN APLICAR al momento de escribirse (2026-08-31). Auditoría de finanzas,
-- ítem 22 (partes a y c; los dos chequeos nuevos y las etiquetas i18n son
-- código: src/lib/period-close-checklist.ts).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- 1. `period_close_checklists` — qué estaba pendiente CUANDO se cerró
-- ═════════════════════════════════════════════════════════════════════════════
--
-- El checklist se computaba EN VIVO, cada vez que alguien abría el diálogo de
-- cierre. O sea que la pregunta «¿qué estaba pendiente cuando cerramos junio?»
-- era incontestable: lo que hoy devuelve la API son los pendientes de HOY, no
-- los de aquel día. Una orden pagada después del cierre desaparece del listado
-- como si nunca hubiera estado.
--
-- Es el mismo criterio que `periods.closing_snapshot` (migración 061): al
-- cerrar se congela lo que había. La diferencia es que aquél congela INSUMOS
-- —porque la fórmula vive en TypeScript y duplicarla en SQL crearía dos copias
-- que se separan (§2.3)— y esto congela un DICTAMEN, que no se recalcula: es
-- la foto de las advertencias que la persona vio (o no vio) antes de apretar
-- el botón. Por eso sí se guarda el resultado.
--
-- Se guarda como `jsonb` y no en columnas: los ítems son un registro que
-- crece (hoy 8; hace un mes eran 4). Una columna por ítem obligaría a una
-- migración por chequeo nuevo y dejaría los cierres viejos con columnas que no
-- existían — que es exactamente la falsedad que esta tabla viene a evitar.
--
-- UNA FILA POR CIERRE, no por período: un mes se puede reabrir y volver a
-- cerrar, y las dos veces son eventos distintos con pendientes distintos. La
-- clave primaria es sintética y `closed_at` ordena.
--
-- SIN POLICIES DE ESCRITURA: escribe el flujo de cierre con el service role
-- (§5, punto 2). Lectura por `auth_company_ids()`, como el resto.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- 2. `close_period` exige orden cronológico
-- ═════════════════════════════════════════════════════════════════════════════
--
-- La cadena de distribución es SECUENCIAL (§2.2 del manual: «hay que procesar
-- TODOS los períodos en orden cronológico, o el arrastre de deuda/reserva
-- diverge»). Cerrar Ago-26 con Jul-26 abierto congela los insumos de agosto
-- contra un arrastre de julio que todavía se puede mover — y como el cierre
-- congela INSUMOS y no resultados, ese número congelado se recalcula solo
-- cuando alguien toque julio. El mes «cerrado» miente sin dar ningún error.
--
-- El bloqueo va en la RPC y no sólo en la pantalla porque la pantalla no es la
-- autoridad: /api/admin/data expone `close_period` y una llamada directa se
-- saltearía el checklist entero. Mismo principio que la migración 079: la
-- plata no puede depender de la corrección del navegador.
--
-- ¿ROMPE ALGO YA CERRADO? No. Verificado en producción (solo lectura,
-- 2026-08-31): los 9 períodos cerrados de Vex Pro son contiguos —Oct-25 a
-- Jun-26— con Jul-26 y Ago-26 abiertos; ninguna otra empresa tiene períodos
-- cerrados. La regla sólo afecta cierres FUTUROS.
--
-- La salida de emergencia existe y es explícita: reabrir el mes anterior con
-- motivo (`reopen_period`, que ya audita), cerrarlo, y después cerrar el
-- siguiente. No hay bandera para saltear el orden: una bandera así se usa una
-- vez «por apuro» y queda para siempre.
--
-- Idempotente: create table if not exists + create or replace.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Tabla del checklist congelado ────────────────────────────────────────
create table if not exists public.period_close_checklists (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  period_id   uuid not null references public.periods(id)   on delete cascade,
  closed_at   timestamptz not null default now(),
  closed_by   uuid references auth.users(id),
  closed_by_name text,
  -- El array de ítems tal cual lo vio quien cerró: key, labelKey, count,
  -- detail, severity. Ver src/lib/period-close-checklist.ts.
  items       jsonb not null default '[]'::jsonb,
  clean       boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists idx_period_close_checklists_period
  on public.period_close_checklists (company_id, period_id, closed_at desc);

comment on table public.period_close_checklists is
  'Foto de los pendientes en el momento exacto del cierre de un período. Se escribe una fila por CIERRE (un mes reabierto y vuelto a cerrar deja dos). Migración 111.';

alter table public.period_close_checklists enable row level security;

drop policy if exists period_close_checklists_select on public.period_close_checklists;
create policy period_close_checklists_select
  on public.period_close_checklists
  for select
  -- `auth_company_ids()` devuelve SETOF uuid: va con `in (select …)`, igual que
  -- en la migración 088. Con `= any(...)` Postgres lo rechaza.
  using (company_id in (select public.auth_company_ids()));

-- Sin policies de INSERT/UPDATE/DELETE a propósito: escribe el cierre con el
-- service role. Un checklist congelado que se pueda editar después no congela
-- nada.

-- ── 2. close_period: orden cronológico obligatorio ──────────────────────────
-- Cuerpo idéntico al de la migración 061 salvo el bloque nuevo.
create or replace function public.close_period(
  p_company_id uuid, p_period_id uuid, p_actor_id uuid, p_actor_name text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_period   record;
  v_snapshot jsonb;
  v_pending  text;
begin
  select * into v_period from public.periods
   where id = p_period_id and company_id = p_company_id;
  if not found then raise exception 'Periodo no encontrado'; end if;
  if v_period.is_closed then
    raise exception 'El periodo % ya esta cerrado', v_period.label;
  end if;

  -- La cadena de distribucion es secuencial: cerrar fuera de orden congela un
  -- mes contra un arrastre que todavia puede cambiar (ver cabecera).
  select string_agg(coalesce(p.label, p.year || '-' || lpad(p.month::text, 2, '0')), ', '
                    order by p.year, p.month)
    into v_pending
  from public.periods p
  where p.company_id = p_company_id
    and coalesce(p.is_closed, false) = false
    and (p.year * 100 + p.month) < (v_period.year * 100 + v_period.month);

  if v_pending is not null then
    raise exception
      'No se puede cerrar % con meses anteriores abiertos: %. Cerralos en orden cronologico.',
      v_period.label, v_pending
      using errcode = 'check_violation';
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

revoke all on function public.close_period(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.close_period(uuid, uuid, uuid, text) to service_role;
