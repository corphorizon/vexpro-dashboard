-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 120 — hr_net_deposit_by_profile: los retiros pasan a
-- transaction_amount, para cuadrar con la pantalla del CRM que ve la gente.
--
-- ── EL HALLAZGO (medido el 2026-09-01, red de archi.arciniegas, agosto) ─────
-- El net del sistema daba 9.772,14 y el panel del CRM 10.702,14. La diferencia
-- son exactamente $930,00 y NO es atribución: son los mismos 262 usuarios con
-- movimiento en los dos lados, y los depósitos cuadran al centavo. Son LAS
-- COMISIONES de los retiros:
--
--   espejo, retiros por requested_amount   = 72.343,64
--   espejo, retiros por transaction_amount = 71.413,64  ← EXACTO al panel
--                                            ─────────
--                                  diferencia    930,00  = la suma de los fees
--
-- ── EL CRM SE CONTRADICE ENTRE SUS PROPIAS PANTALLAS ────────────────────────
-- La migración 113 eligió requested_amount verificando contra el reporte
-- GLOBAL de retiros del CRM (1.007.899,70 cuadra con requested). Pero la
-- pantalla de búsqueda POR USUARIO —la que los comerciales miran a diario—
-- suma transaction_amount (lo que el cliente recibe, neto de fee). Dos
-- pantallas de Orion, dos definiciones. Las dos elecciones "cuadran con el
-- panel"; depende de cuál panel.
--
-- ── LA DECISIÓN (Stiven, 2026-09-01) ────────────────────────────────────────
-- Para COMISIONES manda la pantalla que ve la gente: un informe de net deposit
-- que no cuadra con lo que el comercial ve en el CRM no sirve como informe.
-- Se cambia SOLO esta función, que alimenta únicamente RRHH y Comisiones.
--
-- Lo que NO cambia: el criterio billetera (requested_amount) sigue vigente en
-- el resto del sistema —balances, movimientos, conciliaciones— donde lo que
-- importa es cuánta plata salió de la billetera, no cuánto recibió el cliente.
--
-- Efecto esperado: los nets de los equipos SUBEN por el monto de los fees de
-- retiro de sus clientes (las comisiones calculadas suben con ellos). En la
-- red de archi, agosto: de 9.772,14 a 10.702,14.
--
-- ── DOS DETALLES QUE NO SON OPCIONALES ──────────────────────────────────────
-- 1. El índice cubriente de la 115 incluía requested_amount; sin agregar
--    transaction_amount al INCLUDE, la función vuelve a ir al heap y ya se
--    murió una vez por statement_timeout (por eso existe la 115).
-- 2. CREATE OR REPLACE borra el `set statement_timeout` que la 115 puso con
--    ALTER: hay que volver a declararlo.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. El índice, ahora cubriendo también transaction_amount.
drop index if exists idx_crm_withdrawals_mes;
create index idx_crm_withdrawals_mes
  on public.crm_withdrawals (company_id, status_norm, processed_at)
  include (user_external_id, requested_amount, transaction_amount);

-- 2. La función. Idéntica a la 114 salvo UNA línea: `sum(transaction_amount)`.
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
    -- transaction_amount (lo que el cliente RECIBE) y no requested_amount (lo
    -- que sale de la billetera): es lo que suma la pantalla por usuario del
    -- CRM, que es contra la que se comparan los informes de comisiones.
    -- Ver la cabecera; la diferencia son los fees de retiro.
    select user_external_id, sum(transaction_amount) as v
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

-- 3. El timeout que la 115 había puesto y el CREATE OR REPLACE borra.
alter function public.hr_net_deposit_by_profile(uuid, date) set statement_timeout = '30s';

-- Verificación: el TOTAL del subárbol comercial de Andres Arciniegas (él más
-- sus BDM, que es lo que la pantalla muestra como su ND) tiene que dar
-- exactamente 10.702,14 — el mismo número del panel del CRM para agosto.
--
-- OJO: la fila suelta de la RPC para su perfil es sólo su `own`; el número de
-- la pantalla es la suma del subárbol. Por eso el recursivo de abajo.
with recursive sub as (
  select id from commercial_profiles
   where id = '364ff16a-3399-5344-bfee-2edebd08dcf3'
  union all
  select c.id from commercial_profiles c join sub on c.head_id = sub.id
)
select round(sum(r.net), 2) as total_arciniegas_esperado_10702_14
  from hr_net_deposit_by_profile('71715987-5479-52c4-a990-c414fb3a9b36', '2026-08-01') r
  join sub on sub.id = r.profile_id;
