-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 114 — hr_net_deposit_by_profile: un usuario del CRM mapea a UN
-- solo perfil comercial.
--
-- Hallazgo (2026-08-31, cuadre exacto pedido por Kevin): dos perfiles ACTIVOS
-- («Jose Llanos» 463acfe7… y «Jose Junior» 7dfff4e2…, bajo HEADs distintos)
-- comparten el correo jose.junior@vexprofx.com → su usuario del CRM entraba
-- como raíz DOS veces y el subárbol entero se contaba doble: +$3.140,79 en
-- agosto, sin ningún error. El dato lo arbitra RRHH; la función se blinda
-- igual: `distinct on (un)` con el perfil de alta más reciente (created_at)
-- como ganador determinístico. Cuando corrijan el correo, el distinct es
-- inocuo.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.hr_net_deposit_by_profile(p_company_id uuid, p_month date)
 returns table(profile_id uuid, net numeric, clients bigint)
 language sql
 stable
 set search_path to 'public'
as $function$
  with recursive
  p0 as (
    select id, head_id, email, created_at
      from commercial_profiles
     where company_id = p_company_id
  ),
  p as (
    select p0.id, p0.created_at,
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
  roots as (
    select distinct on (s.un) s.un, p.id as pid
      from s join p on p.k = s.k
     order by s.un, p.created_at desc
  ),
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
