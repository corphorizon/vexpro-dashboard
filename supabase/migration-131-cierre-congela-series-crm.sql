-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 131 — el cierre congela lo que la pantalla mostraba (series CRM)
--
-- POR QUÉ (incidente 2026-10-12): `close_period` (061/111) arma el snapshot
-- leyendo sólo las tablas manuales. Desde el 2026-08-31 el Broker P&L y la
-- Prop Firm de un período ABIERTO salen del CRM, así que cerrar cambiaba el
-- número: Ago-26 de Vex congeló Broker P&L $671.000 (manual viejo) en vez de
-- $304.392,24 y Prop Firm 0 en vez de $9.206,97; Sep-26 congeló 0 y 0 en vez
-- de $226.899,80 y $13.248,27.
--
-- QUÉ CAMBIA: parámetro opcional `p_overrides jsonb`. Las claves presentes
-- (broker_pnl, prop_firm_sales, prop_firm_withdrawals) reemplazan el valor de
-- la tabla; `auto_sources` queda en el snapshot para que se sepa qué salió
-- del CRM. Los valores los calcula el SERVIDOR (src/lib/close-auto-inputs.ts),
-- nunca el navegador. Sin `p_overrides` se comporta exactamente como antes,
-- así que el código viejo sigue funcionando durante el despliegue.
--
-- DESCARTADO: leer crm_daily_pnl / crm_monthly_totals desde acá. Las reglas
-- (corte ago-26, «sin datos ≠ 0», signo invertido) viven en TypeScript con
-- tests; copiarlas a plpgsql sería la segunda lista que se desincroniza.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

drop function if exists public.close_period(uuid, uuid, uuid, text);

create or replace function public.close_period(
  p_company_id uuid,
  p_period_id  uuid,
  p_actor_id   uuid,
  p_actor_name text,
  p_overrides  jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_period   record;
  v_snapshot jsonb;
  v_pending  text;
  v_ov       jsonb := coalesce(p_overrides, '{}'::jsonb);
begin
  select * into v_period from public.periods
   where id = p_period_id and company_id = p_company_id;
  if not found then raise exception 'Periodo no encontrado'; end if;
  if v_period.is_closed then
    raise exception 'El periodo % ya esta cerrado', v_period.label;
  end if;
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
    'broker_pnl', case when v_ov ? 'broker_pnl' then (v_ov->>'broker_pnl')::numeric
                  else coalesce((select broker_pnl from public.operating_income
                                  where period_id = p_period_id limit 1), 0) end,
    'other_income', coalesce((select other from public.operating_income
                               where period_id = p_period_id limit 1), 0),
    'prop_firm_sales', case when v_ov ? 'prop_firm_sales' then (v_ov->>'prop_firm_sales')::numeric
                       else coalesce((select sum(amount) from public.prop_firm_sales
                                       where period_id = p_period_id), 0) end,
    'prop_firm_withdrawals', case when v_ov ? 'prop_firm_withdrawals' then (v_ov->>'prop_firm_withdrawals')::numeric
                             else coalesce((select sum(amount) from public.withdrawals
                                             where period_id = p_period_id
                                               and category = 'prop_firm'), 0) end,
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
    'auto_sources', coalesce(v_ov->'auto_sources', '[]'::jsonb),
    'frozen_at', now()
  ) into v_snapshot;
  update public.periods
     set is_closed = true, closed_at = now(), closed_by = p_actor_id,
         closed_by_name = p_actor_name, closing_snapshot = v_snapshot,
         updated_at = now()
   where id = p_period_id;
  insert into public.audit_logs (company_id, user_id, user_name, action, module, details)
  values (p_company_id, p_actor_id::text, p_actor_name, 'update', 'periods',
          'Periodo ' || v_period.label || ' CERRADO — totales congelados'
          || case when jsonb_array_length(coalesce(v_ov->'auto_sources', '[]'::jsonb)) > 0
                  then ' (del CRM: ' || (v_ov->'auto_sources')::text || ')' else '' end);
  return v_snapshot;
end; $function$;

revoke all on function public.close_period(uuid, uuid, uuid, text, jsonb) from public;
revoke all on function public.close_period(uuid, uuid, uuid, text, jsonb) from anon, authenticated;
grant execute on function public.close_period(uuid, uuid, uuid, text, jsonb) to service_role;

commit;
