-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 097 — El net deposit de cada BDM sale del CRM, no de un Excel
--
-- QUÉ HACE HOY DANIELA A MANO
-- «Ingreso al equipo de Hugo y miro en el CRM cuánto tiene en total y de ese
-- total miro cada uno… cuando sumo todo lo de ellos tengo que restar o sumar
-- para que me dé el valor que sale en el CRM y ese valor se lo pongo al head».
-- Julio 2026: el total del CRM para la estructura de Hugo fue 525.791 y el
-- ajuste que le cargó al head fue −3.489 (ella lo redondeó a «−3.000»).
--
-- ── POR QUÉ HAY QUE CAMINAR EL ÁRBOL Y NO ALCANZA CON sponsor_email ─────────
-- Medido sobre Vex Pro (21.182 clientes en `crm_user_snapshots`):
--   · 19.035 tienen sponsor (89,9%); 2.147 no tienen ninguno.
--   · Hay 1.793 sponsors distintos y solo 114 son perfiles comerciales.
-- O sea: el sponsor directo de un cliente CASI NUNCA es el BDM. Es otro
-- cliente, un IB, un referido de un referido. Atribuir por sponsor directo daba
-- 9 perfiles con movimiento en julio y a Ana García le asignaba −30.799 cuando
-- Daniela le cargó 237.667. Hay que subir por la cadena hasta el primer
-- comercial que aparezca.
--
-- ── POR QUÉ EL CORREO SE NORMALIZA QUITANDO "mail." ─────────────────────────
-- El CRM guarda `ana.garcia@vexprofx.com` y el dashboard `ana.garcia@mail.
-- vexprofx.com`: es la MISMA persona con dos dominios. Comparando en crudo
-- matcheaban 53 de 1.793 sponsors; quitando el `mail.` del dominio, 114. Sin
-- esa línea el módulo entero no funciona.
--
-- ── POR QUÉ NO TODO PERFIL CORTA LA CADENA ─────────────────────────────────
-- Hay perfiles cargados como `bdm` con correo personal y SIN head_id ni
-- hire_date: Starlyn Moya (starlin08_85@yahoo.es), Jose Emanuel Hernandez
-- (facturascasadecambio@gmail.com), Luis Diego López (diegonanolopez@gmail.com).
-- Son IBs / socios, no gente de la estructura comercial, y Daniela no les carga
-- net deposit (en julio figuran en 0 o directamente no figuran). Cuando cortaban
-- la cadena se quedaban con plata que es de su BDM de arriba: Jose Emanuel se
-- llevaba 316.096 y Starlyn 177.679, y Ana García quedaba en −56.512 contra los
-- 237.667 reales. Por eso solo cortan los perfiles que están EN la estructura:
-- los que tienen head_id, o los que tienen a alguien colgando de ellos.
-- Con ese corte, Ana García dio 259.584 y Antony Flores 212.500 contra 212.806
-- cargados a mano (0,14% de diferencia).
--
-- ── QUÉ MOVIMIENTOS CUENTAN ─────────────────────────────────────────────────
-- Depósitos `status_norm='completed'` por `deposit_at`, retiros
-- `status_norm='approved'` por `processed_at`. Julio 2026: 1.454.235 depositado
-- contra 898.429 retirado. Los depósitos `cancelled` (7,5M) y `pending` (2,5M)
-- NO son plata que entró; contarlos multiplicaría el net deposit por seis.
--
-- ── QUÉ TAN BIEN CIERRA (julio 2026, contra lo que cargó Daniela) ───────────
--   Antony Flores      212.500 vs 212.806   (−0,14%)
--   Eric Villanueva    112.063 vs 112.056   (+0,01%)
--   Jackson Araujo      22.130 vs  22.129
--   Estructura de Luka 497.899 vs 496.568   (+0,27%)
--   Estructura de Hugo 541.237 vs 525.791   (+2,94%)
-- La diferencia que queda es cobertura: de los 556.917 netos del mes, 538.604
-- caen bajo algún perfil y 18.314 (3,3%) quedan huérfanos — clientes sin
-- sponsor o cuya cadena se corta en alguien que no está en el snapshot. Por eso
-- la fila con profile_id NULL: el huérfano se MUESTRA, no se reparte a ojo.
--
-- El resultado es una SUGERENCIA. La línea de ajuste que Daniela calcula de
-- memoria sigue existiendo y sigue siendo de ella.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create or replace function public.hr_net_deposit_by_profile(
  p_company_id uuid,
  p_month      date
)
returns table (profile_id uuid, net numeric, clients bigint)
language sql
stable
set search_path to 'public'
as $function$
  with recursive
  -- Solo los perfiles que forman parte de la estructura comercial cortan la
  -- cadena de sponsors. Ver el bloque de arriba: los IBs cargados como `bdm`
  -- sueltos se robaban la producción de su BDM.
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
  -- El `not in (select un from roots)` es lo que hace que la atribución sea al
  -- comercial MÁS CERCANO: cuando la cadena vuelve a tocar un perfil, se frena.
  -- Sin eso, un BDM sponsoreado por su head le duplicaría la producción al head.
  -- El tope de 25 saltos es un cortacircuitos: si alguna vez el CRM devuelve un
  -- ciclo de sponsors, la consulta termina igual en vez de colgar la pantalla.
  tree as (
    select r.un, r.pid, 0 as d from roots r
    union all
    select s.un, t.pid, t.d + 1
      from s join tree t on s.sun = t.un
     where s.un not in (select un from roots) and t.d < 25
  ),
  dep as (
    select user_external_id, sum(deposit_value) as v
      from crm_deposits
     where company_id = p_company_id
       and status_norm = 'completed'
       and deposit_at >= p_month
       and deposit_at <  (p_month + interval '1 month')
     group by 1
  ),
  wd as (
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
  -- pid NULL = huérfanos del mes. Es una fila más, no un error: la pantalla la
  -- muestra como "sin asignar" para que el ajuste del head no la tape.
  select mov.pid, round(sum(mov.neto), 2), count(*)
    from mov
   group by mov.pid;
$function$;

comment on function public.hr_net_deposit_by_profile(uuid, date) is
  'Net deposit del mes (día 1) por perfil comercial, subiendo la cadena de '
  'sponsors del CRM hasta el primer comercial de la estructura. La fila con '
  'profile_id NULL son los clientes cuya cadena no llega a ningún perfil.';

-- Nadie anónimo entra acá: son montos por persona. El dashboard la llama con el
-- cliente admin (service_role); `authenticated` queda para poder probarla desde
-- el SQL editor con una sesión real.
revoke all on function public.hr_net_deposit_by_profile(uuid, date) from public, anon;
grant execute on function public.hr_net_deposit_by_profile(uuid, date) to authenticated, service_role;

commit;
