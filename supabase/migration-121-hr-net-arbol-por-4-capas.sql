-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 121 — hr_net_deposit_by_profile: el árbol de patrocinio se enlaza
-- por 4 capas con precedencia estricta, y se recorre por ID, no por strings.
--
-- ── EL PROBLEMA DE FONDO ────────────────────────────────────────────────────
-- El CRM resuelve el patrocinio por ID interno. Nuestro espejo guarda STRINGS:
-- `crm_user_snapshots.sponsor_username`. Cuando un usuario se renombra, sus
-- hijos siguen apuntando a un username que YA NO EXISTE, el join no encuentra
-- padre y **la subred entera se cae del árbol**. No lanza ningún error: el net
-- del equipo simplemente baja. Es el modo de falla número uno del repo —un
-- número plausible y equivocado— aplicado a la plata de las comisiones.
--
-- ── LA CALIBRACIÓN (2026-09-01, contra el export oficial del panel del CRM) ──
-- Fuente: deposits-withdrawals-2026-09-01.xlsx, red de Hugo Ortiz, agosto 2026.
-- Con la regla nueva:
--
--   subárbol de Hugo Ortiz        = 687.322,96   ← EXACTO al centavo
--   subárbol de Andres Arciniegas =  10.702,14   ← EXACTO al centavo
--
-- Verificado fila a fila sobre las 2.473 filas del panel: **cero usuarios
-- faltantes, cero sobrantes, cero montos distintos**.
--
-- ── LO QUE SE DESCARTÓ (con la medición que lo descartó) ────────────────────
--  1. Atribuir por el jsonb `hierarchy` como fuente PRIMARIA: Andres caía de
--     10.702 a 3.492, porque a 1.975 de 4.670 usuarios de una red les falta el
--     ancestro en `hierarchy`. El panel sigue cadenas de sponsor, NO hierarchy.
--     Hierarchy queda solo como último recurso puntual (capa 4).
--  2. Solo-username (lo que hacían la 114/120): dejaba 97 usuarios de la red de
--     Hugo fuera del árbol.
--  3. Solo-email: rescataba 57 de esos 97, pero SOBRE-contaba (se colgaban de
--     un padre que no era el suyo).
--  Lo que clava el panel es la combinación de las 4 capas con precedencia
--  ESTRICTA: cada capa corre únicamente si TODAS las anteriores fallaron.
--
-- ── LA REGLA DE ENLACE (por usuario, precedencia estricta) ──────────────────
--  CAPA 1 · username: padre = snapshot con un(username) = un(sponsor_username).
--  CAPA 2 · email:    solo si 1 falló y sponsor_email tiene clave. Padre =
--                     snapshot con la misma clave-de-correo (la de la 114).
--  CAPA 3 · rosetta por ID histórico: solo si 1 y 2 fallaron y hay
--                     sponsor_username. Las filas de `crm_withdrawals` guardan
--                     (username, user_external_id) AL MOMENTO de la
--                     transacción: eso da un alias username_viejo → uid, que se
--                     construye SOLO para usernames que hoy no existen (si
--                     existe hoy, la capa 1 ya decidió). El padre es el
--                     snapshot ACTUAL de ese uid. Medido: resuelve 21 enlaces
--                     con 6 alias — p. ej. 'cambiandovidas' → un uid cuyo
--                     snapshot de hoy se llama 'setibajio6': el usuario se
--                     renombró y hasta cambió de correo; solo el ID lo
--                     encuentra. OJO: `crm_deposits` NO tiene columna
--                     `username`; el rastro sale únicamente de los retiros.
--  CAPA 4 · puente por jerarquía: solo si 1, 2 y 3 fallaron Y el usuario SÍ
--                     declara sponsor (username o email no vacíos) — o sea, su
--                     padre existió en el CRM pero fue borrado/renombrado sin
--                     dejar rastro transaccional. Del `hierarchy` del PROPIO
--                     hijo ([{userId, position}], position MAYOR = ancestro MÁS
--                     CERCANO, position 1 = tope) se toma el ancestro de mayor
--                     position que exista hoy en snapshots y no sea él mismo.
--                     Medido: engancha los 11 colgantes que quedaban y es lo
--                     que cierra los últimos −947,70 de Hugo (yiseth, laurale1,
--                     pabml2012, maxnia…, cuyos sponsors nadinrendon /
--                     nico66fx / ecosistemafinanciero no tienen ni snapshot ni
--                     rastro en transacciones).
--
--  Los usuarios SIN sponsor declarado y sin capa que los resuelva quedan
--  HUÉRFANOS, igual que hoy (fila con profile_id null). `null` no es `0`: no
--  se les inventa un padre.
--
--  Todos los desempates son deterministas: cada `distinct on` ordena por
--  user_external_id (o por created_at + id en el caso de los perfiles). Un
--  cursor sin desempate ya se saltó filas una vez en este repo.
--
-- ── EL ÁRBOL AHORA SE RECORRE POR ID ────────────────────────────────────────
-- La recursión baja de cada root por los hijos cuyo PADRE RESUELTO (uid → uid)
-- es el nodo actual, no por `sponsor_username = username`. Semántica idéntica a
-- la 114/120 en todo lo demás: corta en otros roots (un hijo que es root arranca
-- su propio subárbol y no suma al de arriba) y mantiene el tope de profundidad.
-- Como cada usuario tiene UN solo padre resuelto, el grafo es un bosque; aun
-- así se lleva el camino recorrido para cortar ciclos y se deduplica por uid
-- antes de sumar: un usuario contado dos veces es plata contada dos veces.
--
-- ── LO QUE NO CAMBIA RESPECTO DE LA 120 ─────────────────────────────────────
-- Misma firma y mismas columnas de retorno. Roots por clave-de-correo contra
-- commercial_profiles con rol (head o hijo de head), con el DISTINCT ON de la
-- 114. Depósitos: sum(amount_paid), 'completed', por deposit_at. Retiros:
-- sum(transaction_amount), 'approved', por processed_at — la decisión de la 120
-- (es lo que muestra la pantalla de búsqueda del CRM, que es la que ve la
-- gente).
--
-- ── RENDIMIENTO ─────────────────────────────────────────────────────────────
-- El alias rosetta lee `crm_withdrawals` SIN filtro de mes (~14k filas para Vex
-- Pro): entra por (company_id, …) y no necesita índice nuevo. La capa 4 corre
-- solo para el puñado de colgantes (11 hoy), en un lateral sobre su propio
-- jsonb. El índice cubriente de la 115/120 se deja como está.
--
-- ── DE QUÉ DEPENDE ──────────────────────────────────────────────────────────
-- `crm_user_snapshots.hierarchy` lo agrega la 103. `sponsor_email` existe en
-- producción (lo lee /api/partner/v1/customers y lo escribe crm-sync) pero NO
-- tiene migración en el repo — es el hallazgo abierto #1 de las reglas. Si
-- alguna vez esta migración falla al aplicarse por columna inexistente, el
-- entorno no reproduce producción: eso es lo que hay que arreglar, no el SQL.
--
-- ── LA TRAMPA CONOCIDA ──────────────────────────────────────────────────────
-- CREATE OR REPLACE borra el `set statement_timeout` que puso la 115 con ALTER
-- (la 120 ya lo documentó). Se vuelve a declarar al final. No es opcional.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hr_net_deposit_by_profile(p_company_id uuid, p_month date)
 returns table(profile_id uuid, net numeric, clients bigint)
 language sql
 stable
 set search_path to 'public'
as $function$
  with recursive
  -- ── Perfiles comerciales con rol (head o hijo de head) ─────────────────────
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
  -- ── Snapshots del CRM. `k` es la clave-de-correo de la 114 (para los roots);
  -- `ke`/`ksp` son la misma clave pero exigiendo que HAYA una arroba, que es lo
  -- que se calibró: un correo sin '@' no puede emparejar con nadie.
  s as (
    select cs.user_external_id as uid,
           nullif(lower(trim(cs.username)), '')          as un,
           nullif(lower(trim(cs.sponsor_username)), '')  as sun,
           split_part(lower(trim(cs.email)), '@', 1) || '@' ||
           replace(split_part(lower(trim(cs.email)), '@', 2), 'mail.', '') as k,
           case when position('@' in lower(trim(cs.email))) > 0
                then split_part(lower(trim(cs.email)), '@', 1) || '@' ||
                     replace(split_part(lower(trim(cs.email)), '@', 2), 'mail.', '')
           end as ke,
           case when position('@' in lower(trim(cs.sponsor_email))) > 0
                then split_part(lower(trim(cs.sponsor_email)), '@', 1) || '@' ||
                     replace(split_part(lower(trim(cs.sponsor_email)), '@', 2), 'mail.', '')
           end as ksp,
           cs.hierarchy
      from crm_user_snapshots cs
     where cs.company_id = p_company_id
  ),
  -- ── CAPA 1: índice username → uid. Si un username está repetido gana el de
  -- menor user_external_id (determinismo obligatorio).
  ix_un as (
    select distinct on (s.un) s.un, s.uid
      from s
     where s.un is not null
     order by s.un, s.uid
  ),
  -- ── CAPA 2: índice clave-de-correo → uid, mismo desempate.
  ix_email as (
    select distinct on (s.ke) s.ke, s.uid
      from s
     where s.ke is not null
     order by s.ke, s.uid
  ),
  -- ── CAPA 3: la rosetta. (username, user_external_id) tal como quedaron
  -- grabados en cada retiro, para los usernames que HOY YA NO EXISTEN. Si el
  -- username existe hoy, la capa 1 ya decidió y este alias no debe pisarla.
  wd_alias as (
    select nullif(lower(trim(w.username)), '') as un,
           w.user_external_id as uid
      from crm_withdrawals w
     where w.company_id = p_company_id
       and w.user_external_id is not null
  ),
  ros as (
    select distinct on (a.un) a.un, a.uid
      from wd_alias a
     where a.un is not null
       and not exists (select 1 from ix_un i where i.un = a.un)
     order by a.un, a.uid
  ),
  -- El padre de la capa 3 es el snapshot ACTUAL de ese uid: si el uid ya no
  -- tiene snapshot, la capa no resuelve (y el usuario cae a la capa 4).
  ros_snap as (
    select r.un, r.uid
      from ros r
      join s ps on ps.uid = r.uid
  ),
  -- ── Capas 1-3 con precedencia estricta. El coalesce es la precedencia: la
  -- capa 2 solo puede aportar si la 1 dio null, y la 3 solo si la 1 y la 2
  -- dieron null. Las capas 1 y 3 son además excluyentes por construcción (`ros`
  -- excluye los usernames vivos).
  enlace_123 as (
    select s.uid,
           s.sun,
           s.ksp,
           coalesce(c1.uid, c2.uid, c3.uid) as pid_uid
      from s
      left join ix_un    c1 on c1.un = s.sun
      left join ix_email c2 on c2.ke = s.ksp
      left join ros_snap c3 on c3.un = s.sun
  ),
  -- ── CAPA 4: los que siguen colgando PERO declaran sponsor. Su padre existió
  -- en el CRM y desapareció sin rastro: el único hilo que queda es la cadena de
  -- ancestros del propio hijo.
  colgantes as (
    select e.uid, s2.hierarchy
      from enlace_123 e
      join s s2 on s2.uid = e.uid
     where e.pid_uid is null
       and (e.sun is not null or e.ksp is not null)
  ),
  puente as (
    select distinct on (c.uid) c.uid, anc.padre_uid as pid_uid
      from colgantes c
      cross join lateral (
        select h.el ->> 'userId' as padre_uid,
               -- `position` viene como número del normalizador, pero un jsonb no
               -- tiene esquema: si algún día llega como texto, el cast reventaría
               -- la RPC entera. Se acepta sólo si ES número.
               case when jsonb_typeof(h.el -> 'position') = 'number'
                    then (h.el ->> 'position')::numeric
                    else 0
               end as pos
          from jsonb_array_elements(
                 case when jsonb_typeof(c.hierarchy) = 'array'
                      then c.hierarchy
                      else '[]'::jsonb
                 end
               ) as h(el)
         where jsonb_typeof(h.el) = 'object'
      ) anc
     where anc.padre_uid is not null
       and anc.padre_uid <> c.uid
       and exists (select 1 from s sp where sp.uid = anc.padre_uid)
     -- position MAYOR = ancestro MÁS CERCANO. El desempate por uid es para que
     -- dos ancestros con la misma position no dependan del orden del jsonb.
     order by c.uid, anc.pos desc, anc.padre_uid
  ),
  -- El padre definitivo: capas 1-3, y si ninguna resolvió, el puente.
  enlace as (
    select e.uid, coalesce(e.pid_uid, pu.pid_uid) as pid_uid
      from enlace_123 e
      left join puente pu on pu.uid = e.uid
  ),
  -- ── Roots: el usuario del CRM que ES un comercial. DISTINCT ON de la 114:
  -- dos perfiles activos con el mismo correo contaban el subárbol dos veces
  -- (+$3.140,79 en agosto). Gana el perfil de alta más reciente; `p.id` cierra
  -- el empate improbable de dos created_at idénticos.
  roots as (
    select distinct on (s.uid) s.uid, p.id as pid
      from s join p on p.k = s.k
     order by s.uid, p.created_at desc, p.id
  ),
  -- ── El árbol, ahora por uid → uid. Corta en otros roots (mismas semánticas
  -- que la 114/120) y lleva el camino recorrido para no entrar en ciclos.
  tree as (
    select r.uid, r.pid, 0 as d, array[r.uid] as camino
      from roots r
    union all
    select e.uid, t.pid, t.d + 1, t.camino || e.uid
      from enlace e
      join tree t on t.uid = e.pid_uid
     where t.d < 25
       and not exists (select 1 from roots rr where rr.uid = e.uid)
       and not (e.uid = any (t.camino))
  ),
  -- Defensa: un uid nunca puede aportar dos veces. Con un solo padre por
  -- usuario esto no debería recortar nada; si algún día recorta, es porque el
  -- grafo dejó de ser un bosque y estaríamos contando plata doble.
  arbol as (
    select distinct on (t.uid) t.uid, t.pid
      from tree t
     order by t.uid, t.d, t.pid
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
    -- transaction_amount (lo que el cliente RECIBE) y no requested_amount:
    -- decisión de la 120, es lo que suma la pantalla por usuario del CRM.
    select user_external_id, sum(transaction_amount) as v
      from crm_withdrawals
     where company_id = p_company_id
       and status_norm = 'approved'
       and processed_at >= p_month
       and processed_at <  (p_month + interval '1 month')
     group by 1
  ),
  mov as (
    select s.uid,
           a.pid,
           coalesce(dep.v, 0) - coalesce(wd.v, 0) as neto
      from s
      left join arbol a on a.uid = s.uid
      left join dep on dep.user_external_id = s.uid
      left join wd  on  wd.user_external_id = s.uid
     where coalesce(dep.v, 0) <> 0 or coalesce(wd.v, 0) <> 0
  )
  -- La fila con pid null son los huérfanos: usuarios con movimiento que no
  -- cuelgan de ningún comercial. Se devuelven, no se esconden.
  select mov.pid, round(sum(mov.neto), 2), count(*)
    from mov
   group by mov.pid;
$function$;

-- El timeout que puso la 115 con ALTER y que el CREATE OR REPLACE de arriba
-- acaba de borrar. Sin esto la función vuelve al default del rol.
alter function public.hr_net_deposit_by_profile(uuid, date) set statement_timeout = '30s';

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN (correr a mano; los dos números salen del export oficial del
-- panel del CRM para agosto 2026). Igual que en la 120: la fila suelta de la
-- RPC para un perfil es sólo su `own`; el número de la pantalla es la suma del
-- SUBÁRBOL de perfiles, por eso los recursivos.
--
-- 1) Hugo Ortiz → tiene que dar 687322.96
--
-- with recursive raiz as (
--   select id from commercial_profiles
--    where company_id = '71715987-5479-52c4-a990-c414fb3a9b36'
--      and name ilike '%hugo ortiz%'
-- ), sub as (
--   select id from raiz
--   union all
--   select c.id from commercial_profiles c join sub on c.head_id = sub.id
-- )
-- select round(sum(r.net), 2) as total_hugo_esperado_687322_96
--   from hr_net_deposit_by_profile('71715987-5479-52c4-a990-c414fb3a9b36', '2026-08-01') r
--   join sub on sub.id = r.profile_id;
--
-- 2) Andres Arciniegas → tiene que dar 10702.14
--
-- with recursive raiz as (
--   select id from commercial_profiles
--    where company_id = '71715987-5479-52c4-a990-c414fb3a9b36'
--      and name ilike '%arciniegas%'
-- ), sub as (
--   select id from raiz
--   union all
--   select c.id from commercial_profiles c join sub on c.head_id = sub.id
-- )
-- select round(sum(r.net), 2) as total_arciniegas_esperado_10702_14
--   from hr_net_deposit_by_profile('71715987-5479-52c4-a990-c414fb3a9b36', '2026-08-01') r
--   join sub on sub.id = r.profile_id;
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- SEGUIDO POR LA MIGRACIÓN 123 (mismo patrón que 113 → 120 → 121)
--
-- Las capas 1-4 que están escritas arriba YA NO VIVEN dentro de esta función:
-- la 123 las extrajo a `public.hr_padres_resueltos(company)` porque una segunda
-- RPC (`hr_pnl_input_by_profile`, el PnL del CRM para Comisiones RRHH) necesita
-- exactamente el mismo árbol, y copiarlo era fabricar la lista duplicada que se
-- desincroniza en silencio (§1.1).
--
-- Esta cabecera sigue siendo el documento de POR QUÉ el árbol es así — las 4
-- capas, lo que se descartó y los números de la calibración. El CÓDIGO vivo del
-- árbol está en la 123. Si hay que tocar una capa, se toca allá y se vuelve a
-- correr la verificación de acá: Hugo 687.322,96 y Arciniegas 10.702,14 para
-- 2026-08-01 son el contrato, y la 123 los repite al pie por eso mismo.
-- ─────────────────────────────────────────────────────────────────────────────
