-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 113 — hr_net_deposit_by_profile: llaves canónicas de monto
-- NOTA (2026-09-01): la elección de requested_amount para los RETIROS fue
-- revisada en la migración 120 — la pantalla por usuario del CRM (la que ven
-- los comerciales) suma transaction_amount, y para comisiones manda esa. El
-- resto de esta cabecera sigue vigente (amount_paid, fechas, status).
--
--
-- Kevin (2026-08-31): «alinea la llave de fecha para que cuadre exacto» contra
-- el panel del CRM. Al leer la definición, el desvío no era (solo) la fecha:
--
--   · depósitos usaba `deposit_value` — la INTENCIÓN del usuario, no dinero
--     (contrato del repo en partner/v1/customers: la canónica de lo acreditado
--     es `amount_paid`). El panel de Orion suma amount_paid: reproduje su
--     Total Deposits de agosto (1.695.145,84) exacto con amount_paid por
--     deposit_at.
--   · retiros usaba `transaction_amount` — lo que el cliente recibe NETO de
--     comisión. El criterio billetera (y el panel) es `requested_amount`, lo
--     que SALE de la billetera. Verificado: trx + fee = requested en las
--     2.379 filas de agosto, y el Total Withdrawals del panel (1.007.899,70)
--     avanza con requested_amount por processed_at.
--
-- La fecha queda: deposit_at para depósitos, processed_at para retiros —
-- las mismas del panel.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.hr_net_deposit_by_profile(p_company_id uuid, p_month date)
 returns table(profile_id uuid, net numeric, clients bigint)
 language sql
 stable
 set search_path to 'public'
as $function$
  with recursive
  p0 as (
    select id, head_id, email
      from commercial_profiles
     where company_id = p_company_id
  ),
  p as (
    select p0.id,
           split_part(lower(trim(p0.email)), '@', 1) || '@' ||
           replace(split_part(lower(trim(p0.email)), '@', 2), 'mail.', '') as k
      from p0
     where p0.head_id is not null
        or exists (select 1 from p0 c where c.head_id = p0.id)
  ),
  s as (
    select user_external_id,
           lower(trim(username)) as un,
           nullif(lower(trim(sponsor_username)), '') as sun,
           split_part(lower(trim(email)), '@', 1) || '@' ||
           replace(split_part(lower(trim(email)), '@', 2), 'mail.', '') as k
      from crm_user_snapshots
     where company_id = p_company_id
  ),
  roots as (select s.un, p.id as pid from s join p on p.k = s.k),
  tree as (
    select r.un, r.pid, 0 as d from roots r
    union all
    select s.un, t.pid, t.d + 1
      from s join tree t on s.sun = t.un
     where s.un not in (select un from roots) and t.d < 25
  ),
  dep as (
    select user_external_id, sum(amount_paid) as v
      from crm_deposits
     where company_id = p_company_id
       and status_norm = 'completed'
       and deposit_at >= p_month
       and deposit_at <  (p_month + interval '1 month')
     group by 1
  ),
  wd as (
    select user_external_id, sum(requested_amount) as v
      from crm_withdrawals
     where company_id = p_company_id
       and status_norm = 'approved'
       and processed_at >= p_month
       and processed_at <  (p_month + interval '1 month')
     group by 1
  ),
  mov as (
    select s.user_external_id,
           t.pid,
           coalesce(dep.v, 0) - coalesce(wd.v, 0) as neto
      from s
      left join tree t   on t.un = s.un
      left join dep on dep.user_external_id = s.user_external_id
      left join wd  on  wd.user_external_id = s.user_external_id
     where coalesce(dep.v, 0) <> 0 or coalesce(wd.v, 0) <> 0
  )
  select mov.pid, round(sum(mov.neto), 2), count(*)
    from mov
   group by mov.pid;
$function$;
