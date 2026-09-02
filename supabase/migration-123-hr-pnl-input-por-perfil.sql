-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 123 — Los dos insumos del grupo PnL de Comisiones RRHH salen del
-- CRM, y el árbol de patrocinio pasa a tener UN SOLO registro canónico.
--
-- (123 y no otro: el último aplicado es el 122. Verificado con
--  `ls supabase/migration-*.sql | tail -3` antes de escribir este archivo. El
--  número se re-elige AL MERGEAR si otra rama lo tomó — §0 de
--  docs/reglas-del-proyecto.md.)
--
-- ── QUÉ PROBLEMA RESUELVE ───────────────────────────────────────────────────
-- En Comisiones RRHH, el grupo PnL se carga HOY A MANO: alguien abre el CRM,
-- mira dos pantallas y transcribe dos números por comercial. Es el mismo modo
-- de falla que ya costó plata en este repo — un número plausible tecleado mal
-- no lanza ninguna excepción, y el default del input es 0, que es
-- indistinguible de "no lo cargué" (§6). Esta migración deja los dos campos
-- autocalculados desde el espejo del CRM.
--
--   · "Com. Lotes" = Commissions Report del CRM, del PROPIO usuario del perfil.
--   · "PnL"        = PNL Report del CRM, de TODA la subred del perfil.
--
-- ── LA CALIBRACIÓN (2026-09-02, contra las pantallas oficiales del CRM) ──────
-- Junio 2026, empresa Vex Pro. Los dos reports, usuario por usuario:
--
--   Com. Lotes (Commissions Report, suma mensual de commission del propio uid)
--     diegonanolopez        =  3.399,39   ← EXACTO
--     millonariosteam2018   = 45.924,62   ← EXACTO
--
--   PnL (PNL Report, suma mensual de la SUBRED entera, él incluido)
--     diegonanolopez        = −6.336,14 · 8.094,00 lotes · 19.622 deals
--                             ← TRIPLE MATCH con el report (dinero, lotes y
--                               operaciones a la vez). Que cuadren las tres
--                               cifras y no sólo el dinero es lo que descarta
--                               que sea una coincidencia de compensaciones.
--
-- ── LO QUE SE DESCARTÓ (con la medición que lo descartó) ─────────────────────
--  1. `crm_ib_reward_daily.pnl` como fuente del PnL. Es la trampa obvia: la
--     tabla ya está ahí y la columna se llama "pnl". Pero ese campo es el PNL
--     del TRADER repetido UNA VEZ POR NIVEL DE IB que cobra la operación —
--     4,9 niveles por operación de promedio, medido en la 098. Sumarlo por
--     usuario da un disparate: para millonariosteam2018 en agosto salía
--     −78.000.000 contra los ~−100k del report. Es dinero contado cinco veces.
--     La fuente correcta es `crm_daily_pnl_users` (migración 122), que atribuye
--     el PNL a la PERSONA dueña de la cuenta, una sola vez.
--  2. Cortar la recursión en otros roots comerciales, como hace el net deposit.
--     El PNL Report NO corta: se le pide un usuario y suma su red completa,
--     otros comerciales incluidos. Verificado con el triple match de arriba —
--     con cortes, la subred de diegonanolopez no da ni el dinero, ni los lotes,
--     ni los deals. Es la diferencia semántica entre los dos números: el net
--     deposit reparte (por eso corta, para no pagar dos veces), el PnL informa.
--     Consecuencia esperada y correcta: si un perfil PnL cuelga de otro perfil
--     PnL, el de arriba incluye al de abajo. Así lo muestra el CRM.
--  3. Copiar el árbol de la 121 acá. Ver el punto siguiente.
--
-- ── POR QUÉ APARECE `hr_padres_resueltos` ───────────────────────────────────
-- Las dos RPC necesitan EL MISMO árbol de patrocinio de 4 capas. Copiarlo sería
-- fabricar la segunda lista: *"listas duplicadas que se desincronizan en
-- silencio son el modo de falla número uno de este repo"* (§1.1). Y acá el
-- silencio es total — las dos copias seguirían compilando y devolviendo números
-- plausibles, sólo que de árboles distintos, y nadie lo vería hasta que un
-- comercial reclame.
--
-- Así que las capas 1-4 salen de `hr_net_deposit_by_profile` y pasan a ser una
-- función propia. `public.hr_padres_resueltos(company)` es desde hoy EL
-- REGISTRO CANÓNICO del árbol de patrocinio: quien necesite subir o bajar por
-- sponsors lo llama, no lo reescribe. La 121 sigue siendo el documento donde
-- está escrito POR QUÉ el árbol es así (las 4 capas, lo que se descartó y los
-- números de la calibración): esta migración mueve el código, no la doctrina.
--
-- El refactor es a resultado constante y hay cómo probarlo: las dos
-- verificaciones de la 121 (Hugo 687.322,96 y Arciniegas 10.702,14 para agosto
-- 2026) están repetidas al pie con los MISMOS números esperados. Si el refactor
-- mueve un centavo, está mal — no "cambió un poco".
--
-- ── LA TRAMPA NUEVA: UNA FUNCIÓN DENTRO DE UN RECURSIVO ─────────────────────
-- `hr_padres_resueltos` se invoca dentro del término recursivo del árbol. Una
-- CTE que se referencia UNA SOLA VEZ es candidata a que el planner la haga
-- inline (Postgres 12+), y una función devuelve-conjunto inline-ada en el
-- término recursivo se re-ejecutaría EN CADA NIVEL: hasta 25 barridos completos
-- de snapshots + retiros por llamada, con el statement_timeout de 30s
-- esperando del otro lado. Por eso el CTE `enlace` va declarado
-- `AS MATERIALIZED` en las dos RPC. No es cosmético y no se saca.
--
-- ── RENDIMIENTO ─────────────────────────────────────────────────────────────
-- Medido sobre los datos de hoy: hay ~6 perfiles con `pnl_pct`, pero la subred
-- de uno de ellos tiene 3.222 usuarios y `crm_daily_pnl_users` mueve ~40.000
-- filas por mes. La forma de la consulta evita el producto: el árbol se
-- materializa UNA vez, el mes de PNL se agrega UNA vez por usuario, y recién
-- entonces se juntan por uid. No hace falta índice nuevo:
--   · `crm_daily_pnl_users` — la PK (company_id, utc_day, user_external_id)
--     cubre exactamente el filtro empresa + rango de mes.
--   · `crm_ib_reward_daily` — `idx_crm_ib_reward_daily_dia` (company_id, day)
--     deja el mes en ~5.500 filas, contra las que se cruzan 6 uids.
-- Si algún día esto se acerca a los 30 s, el índice que faltaría es sobre
-- `crm_ib_reward_daily (company_id, ib_user_id, day)` — pero hoy sería un
-- índice para 6 lecturas por mes, y no está justificado.
--
-- ── EL SIGNO SE DEVUELVE CRUDO ──────────────────────────────────────────────
-- `pnl_crm` sale con el signo del CRM: NEGATIVO = los clientes perdieron = el
-- bróker ganó (mismo criterio que la 106 y la 122). El campo de la pantalla de
-- comisiones se lee al revés —lo que la empresa gana— así que la inversión la
-- hace el ENDPOINT, no esta RPC. A propósito: una RPC que ya viene invertida y
-- otra que no, sobre la misma columna del mismo espejo, es la clase de detalle
-- que se olvida y termina pagando con el signo cambiado.
--
-- ── null ≠ 0, y acá los dos casos conviven ──────────────────────────────────
-- Perfil SIN usuario en el CRM → `pnl_crm` y `com_lotes` NULL: no lo sabemos,
-- y la pantalla tiene que decirlo en vez de mostrar un cero tranquilizador.
-- Perfil CON usuario y sin actividad → 0: el Commissions Report muestra
-- literalmente $0.00 y el PNL Report "0 records". Eso sí es un cero medido.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. EL ÁRBOL DE PATROCINIO, EN UN SOLO LUGAR
--
-- Capas 1 a 4 con precedencia ESTRICTA, tal como las calibró la 121 contra el
-- export oficial del panel (2.473 filas, cero faltantes, cero sobrantes):
--
--   CAPA 1 · username    — padre = snapshot con un(username) = un(sponsor_username)
--   CAPA 2 · email       — sólo si 1 falló: misma clave-de-correo que sponsor_email
--   CAPA 3 · rosetta     — sólo si 1 y 2 fallaron: (username, uid) tal como
--                          quedaron grabados en `crm_withdrawals`, para
--                          usernames que HOY YA NO EXISTEN
--   CAPA 4 · hierarchy   — sólo si 1, 2 y 3 fallaron Y el usuario declara
--                          sponsor: ancestro de mayor `position` que exista hoy
--
-- El porqué de cada capa, con la medición que la justifica y las tres
-- alternativas que se descartaron, está en la cabecera de la migración 121. No
-- se repite acá para que haya un solo texto que mantener.
--
-- Devuelve UNA fila por usuario del CRM de la empresa. `padre_uid` NULL = el
-- usuario es huérfano: ninguna capa lo resolvió. NULL no es "cuelga de nadie
-- por ahora", es "no lo sabemos", y no se le inventa un padre.
--
-- Todos los desempates son deterministas (`distinct on` ordenado por
-- user_external_id): un cursor sin desempate ya se saltó filas una vez acá.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hr_padres_resueltos(p_company_id uuid)
 returns table(uid text, padre_uid text)
 language sql
 stable
 set search_path to 'public'
as $function$
  with
  -- `ke`/`ksp` son la clave-de-correo de la 114 EXIGIENDO que haya arroba: un
  -- correo sin '@' no puede emparejar con nadie. (La variante sin la guarda,
  -- `k`, sólo se usa para los roots y por eso vive en quien la necesita.)
  s as (
    select cs.user_external_id as uid,
           nullif(lower(trim(cs.username)), '')          as un,
           nullif(lower(trim(cs.sponsor_username)), '')  as sun,
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
  -- OJO: `crm_deposits` NO tiene columna `username`; el rastro sale únicamente
  -- de los retiros.
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
  -- ── Capas 1-3 con precedencia estricta. El coalesce ES la precedencia: la
  -- capa 2 sólo puede aportar si la 1 dio null, y la 3 sólo si la 1 y la 2
  -- dieron null. Las capas 1 y 3 son además excluyentes por construcción
  -- (`ros` excluye los usernames vivos).
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
    -- La columna del lateral se llama `anc_uid` y no `padre_uid` como en la
    -- 121: `padre_uid` es ahora un parámetro OUT de esta función, y en una
    -- función SQL un identificador que coincide con un parámetro se resuelve
    -- en silencio a favor de la columna. Acá todo va calificado igual, pero no
    -- se deja un nombre que pueda morder al que edite esto en dos años.
    select distinct on (c.uid) c.uid, anc.anc_uid as pid_uid
      from colgantes c
      cross join lateral (
        select h.el ->> 'userId' as anc_uid,
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
     where anc.anc_uid is not null
       and anc.anc_uid <> c.uid
       and exists (select 1 from s sp where sp.uid = anc.anc_uid)
     -- position MAYOR = ancestro MÁS CERCANO. El desempate por uid es para que
     -- dos ancestros con la misma position no dependan del orden del jsonb.
     order by c.uid, anc.pos desc, anc.anc_uid
  )
  -- El padre definitivo: capas 1-3, y si ninguna resolvió, el puente.
  -- Todas las referencias van CALIFICADAS por alias: `uid` y `padre_uid` son
  -- además nombres de parámetro OUT de esta función, y en una función SQL un
  -- nombre sin calificar que coincide con un parámetro se resuelve en silencio.
  select e.uid, coalesce(e.pid_uid, pu.pid_uid)
    from enlace_123 e
    left join puente pu on pu.uid = e.uid;
$function$;

comment on function public.hr_padres_resueltos(uuid) is
  'EL registro canonico del arbol de patrocinio del CRM: una fila por usuario '
  'con su padre resuelto por las 4 capas con precedencia estricta (username, '
  'email, rosetta de crm_withdrawals, hierarchy) calibradas en la migracion '
  '121 contra el export oficial del panel. padre_uid NULL = huerfano (no se le '
  'inventa padre). Quien necesite recorrer sponsors LLAMA a esta funcion: '
  'copiar la logica crea la segunda lista que se desincroniza en silencio.';

revoke all on function public.hr_padres_resueltos(uuid) from public, anon;
grant execute on function public.hr_padres_resueltos(uuid) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. hr_net_deposit_by_profile — MISMO NÚMERO, EL ÁRBOL AHORA SE PIDE PRESTADO
--
-- Refactor a resultado constante. Lo único que cambia respecto de la 121:
--   · las CTEs `ix_un`, `ix_email`, `wd_alias`, `ros`, `ros_snap`,
--     `enlace_123`, `colgantes` y `puente` se van a `hr_padres_resueltos`;
--   · el CTE `s` que queda acá conserva sólo las dos columnas que esta función
--     sigue usando (`uid` para el árbol y los movimientos, `k` para los roots).
--     Las demás las consume ahora la función compartida.
--   · el enlace entra como CTE `AS MATERIALIZED` — obligatorio, ver la trampa
--     en la cabecera.
-- Todo lo demás es letra por letra la 121: roots con el DISTINCT ON de la 114,
-- corte en otros roots, tope de profundidad 25, camino anticiclos, dedup por
-- uid, depósitos por `amount_paid`/'completed'/`deposit_at`, retiros por
-- `transaction_amount`/'approved'/`processed_at` (la decisión de la 120), y las
-- mismas tres columnas de retorno con los huérfanos en la fila de profile_id
-- NULL.
--
-- OJO, la trampa conocida: CREATE OR REPLACE borra el `set statement_timeout`
-- que puso la 115 con ALTER (ya lo documentó la 120 y lo repitió la 121). Se
-- vuelve a declarar abajo. No es opcional. Los GRANT, en cambio, SÍ sobreviven
-- a un CREATE OR REPLACE — lo que los borraría es un DROP + CREATE.
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
  -- ── Snapshots del CRM. `k` es la clave-de-correo de la 114 (para los roots),
  -- SIN la guarda de arroba: así se calibró el emparejamiento perfil ↔ usuario.
  s as (
    select cs.user_external_id as uid,
           split_part(lower(trim(cs.email)), '@', 1) || '@' ||
           replace(split_part(lower(trim(cs.email)), '@', 2), 'mail.', '') as k
      from crm_user_snapshots cs
     where cs.company_id = p_company_id
  ),
  -- ── El árbol de 4 capas, del registro canónico. MATERIALIZED porque se usa
  -- dentro del término recursivo: sin esto el planner puede inline-arlo y
  -- re-ejecutar la función en cada uno de los 25 niveles.
  enlace as materialized (
    select hpr.uid, hpr.padre_uid
      from hr_padres_resueltos(p_company_id) hpr
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
  -- ── El árbol, por uid → uid. Corta en otros roots (mismas semánticas que la
  -- 114/120: un hijo que es root arranca su propio subárbol y no suma al de
  -- arriba) y lleva el camino recorrido para no entrar en ciclos.
  tree as (
    select r.uid, r.pid, 0 as d, array[r.uid] as camino
      from roots r
    union all
    select e.uid, t.pid, t.d + 1, t.camino || e.uid
      from enlace e
      join tree t on t.uid = e.padre_uid
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
-- 3. hr_pnl_input_by_profile — los dos insumos del grupo PnL
--
-- Devuelve UNA fila por perfil con `pnl_pct` no nulo. Los perfiles sin `pnl_pct`
-- no cobran por PnL: calcularles el número sería trabajo que nadie mira.
--
-- `pnl_crm`      suma mensual de crm_daily_pnl_users.pnl_usd de TODA la subred
--                del usuario CRM del perfil, él incluido, SIN cortar en otros
--                comerciales. Signo CRUDO del CRM (negativo = el cliente
--                perdió); invertir es tarea del endpoint.
-- `com_lotes`    suma mensual de crm_ib_reward_daily.commission del uid PROPIO
--                del perfil. Sólo de él: el Commissions Report es por usuario,
--                no por red.
-- `usuarios_red` cuántos usuarios entraron en esa subred, para que la pantalla
--                pueda mostrar de dónde sale el número.
--
-- LOS TRES ESTADOS DE UNA FILA (§1.3 en acción):
--   · perfil SIN usuario en el CRM → pnl_crm, com_lotes y usuarios_red NULL.
--     "No lo sabemos". Un 0 acá diría "su red no operó", que es otra cosa.
--   · perfil CON usuario y sin actividad en el mes → 0. Es el $0.00 y los
--     "0 records" que muestran los reports: un cero medido.
--   · perfil CON usuario, con filas de PNL pero todas con pnl_usd NULL →
--     pnl_crm NULL. Hubo actividad y no fue calculable; tampoco es cero.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.hr_pnl_input_by_profile(p_company_id uuid, p_month date)
 returns table(profile_id uuid, pnl_crm numeric, com_lotes numeric, usuarios_red bigint)
 language sql
 stable
 set search_path to 'public'
as $function$
  with recursive
  -- ── Los perfiles que cobran por PnL. La clave-de-correo es la misma de la
  -- 114/121, sin la guarda de arroba, para que un perfil resuelva SIEMPRE al
  -- mismo usuario CRM que resuelve en hr_net_deposit_by_profile.
  p as (
    select cp.id,
           split_part(lower(trim(cp.email)), '@', 1) || '@' ||
           replace(split_part(lower(trim(cp.email)), '@', 2), 'mail.', '') as k
      from commercial_profiles cp
     where cp.company_id = p_company_id
       and cp.pnl_pct is not null
  ),
  s as (
    select cs.user_external_id as uid,
           split_part(lower(trim(cs.email)), '@', 1) || '@' ||
           replace(split_part(lower(trim(cs.email)), '@', 2), 'mail.', '') as k
      from crm_user_snapshots cs
     where cs.company_id = p_company_id
  ),
  -- ── El usuario CRM del perfil. Si dos snapshots comparten clave-de-correo
  -- gana el de menor user_external_id: mismo criterio de desempate determinista
  -- que usan las capas del árbol. Un perfil sin match no aparece acá y su fila
  -- sale en NULL.
  propio as (
    select distinct on (p.id) p.id as pid, s.uid
      from p join s on s.k = p.k
     order by p.id, s.uid
  ),
  -- ── El árbol canónico. MATERIALIZED: se usa dentro del término recursivo y
  -- sin esto la función se re-ejecutaría en cada nivel. Ver la cabecera.
  enlace as materialized (
    select hpr.uid, hpr.padre_uid
      from hr_padres_resueltos(p_company_id) hpr
  ),
  -- ── La subred de cada perfil, bajando por padre resuelto. SIN el corte en
  -- otros roots que sí tiene el net deposit: el PNL Report no corta (ver "lo
  -- que se descartó" #2). Tope de profundidad 25 y camino recorrido para no
  -- entrar en ciclos, igual que el árbol de la 121.
  red as (
    select pr.pid, pr.uid, 0 as d, array[pr.uid] as camino
      from propio pr
    union all
    select r.pid, e.uid, r.d + 1, r.camino || e.uid
      from enlace e
      join red r on r.uid = e.padre_uid
     where r.d < 25
       and not (e.uid = any (r.camino))
  ),
  -- Un uid no puede contar dos veces DENTRO de la subred de un perfil: sería
  -- sumarle su PNL dos veces. Entre perfiles distintos sí puede repetirse, y
  -- debe: si un perfil PnL cuelga de otro, el de arriba lo incluye — así lo
  -- muestra el CRM.
  red_dedup as (
    select distinct on (r.pid, r.uid) r.pid, r.uid
      from red r
     order by r.pid, r.uid, r.d
  ),
  -- ── El mes de PNL, agregado UNA vez por usuario antes de cruzarlo con el
  -- árbol (son ~40k filas por mes; cruzar primero y agregar después multiplica
  -- el trabajo por la cantidad de perfiles).
  -- La fila sentinela '(sin-dueño)' de la 122 se excluye EXPLÍCITAMENTE: es
  -- dinero real de cuentas sin dueño en Orion y no pertenece a la red de nadie.
  -- La 122 pide que se la excluya a propósito, no por casualidad.
  --   OJO CON EL LITERAL: lleva eñe, y este archivo es UTF-8. Aplicarlo con un
  --   client_encoding distinto rompe la comparación EN SILENCIO. La red de
  --   seguridad es que el join contra el árbol tampoco la alcanzaría (la
  --   sentinela no tiene snapshot, así que no cuelga de nadie), pero el filtro
  --   va igual: la 122 pide que se la excluya a propósito, y una defensa que
  --   depende de que "no debería pasar" no es una defensa.
  pnl_mes as (
    select d.user_external_id as uid,
           sum(d.pnl_usd) as v
      from crm_daily_pnl_users d
     where d.company_id = p_company_id
       and d.utc_day >= p_month
       and d.utc_day <  (p_month + interval '1 month')
       and d.user_external_id <> '(sin-dueño)'
     group by d.user_external_id
  ),
  pnl_por_perfil as (
    select rd.pid, sum(pm.v) as v
      from red_dedup rd
      join pnl_mes pm on pm.uid = rd.uid
     group by rd.pid
  ),
  -- ── La comisión por lotes es del uid PROPIO, no de la red. `commission` es
  -- `not null default 0` en la 098, así que si hay filas la suma no es NULL.
  com as (
    select pr.pid, sum(ib.commission) as v
      from propio pr
      join crm_ib_reward_daily ib
        on ib.ib_user_id = pr.uid
       and ib.company_id = p_company_id
       and ib.day >= p_month
       and ib.day <  (p_month + interval '1 month')
     group by pr.pid
  ),
  tam as (
    select rd.pid, count(*)::bigint as n
      from red_dedup rd
     group by rd.pid
  )
  -- Los NULL y los ceros van CASTEADOS: en un CASE, un `null` pelado no tiene
  -- tipo y el `0` es integer. Con RETURNS TABLE el mapeo es posicional y una
  -- sorpresa de tipo acá se manifestaría como un error de la RPC entera, no
  -- como un número raro — pero el cast explícito también documenta que
  -- usuarios_red es bigint y no un conteo cualquiera.
  select p.id,
         -- Sin usuario CRM → NULL. Con usuario y sin ninguna fila del mes en la
         -- subred → 0 (el report da "0 records"). Con filas pero suma NULL
         -- (todas las pnl_usd nulas) → NULL: hubo actividad y no fue calculable.
         case when pr.uid is null   then null::numeric
              when pp.pid is null   then 0::numeric
              else round(pp.v, 2)
         end,
         case when pr.uid is null then null::numeric
              else round(coalesce(c.v, 0), 2)
         end,
         case when pr.uid is null then null::bigint else coalesce(t.n, 0::bigint) end
    from p
    left join propio         pr on pr.pid = p.id
    left join pnl_por_perfil pp on pp.pid = p.id
    left join com            c  on  c.pid = p.id
    left join tam            t  on  t.pid = p.id;
$function$;

comment on function public.hr_pnl_input_by_profile(uuid, date) is
  'Los dos insumos del grupo PnL de Comisiones RRHH para un mes (dia 1): '
  'com_lotes = Commissions Report del CRM (commission del uid PROPIO del '
  'perfil) y pnl_crm = PNL Report (pnl_usd de TODA la subred, el incluido, SIN '
  'cortar en otros comerciales, excluyendo la fila sentinela (sin-dueno)). '
  'pnl_crm sale con el signo CRUDO del CRM: negativo = el cliente perdio; '
  'invertirlo es tarea del endpoint. NULL en las tres columnas = el perfil no '
  'tiene usuario en el CRM (no lo sabemos); 0 = no hubo actividad.';

revoke all on function public.hr_pnl_input_by_profile(uuid, date) from public, anon;
grant execute on function public.hr_pnl_input_by_profile(uuid, date) to authenticated, service_role;

alter function public.hr_pnl_input_by_profile(uuid, date) set statement_timeout = '30s';

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN A · EL REFACTOR NO MUEVE UN CENTAVO
--
-- Son LAS MISMAS dos consultas de la migración 121, con LOS MISMOS números
-- esperados (export oficial del panel del CRM, agosto 2026). Si alguna de las
-- dos da otra cosa, el punto 2 de esta migración está mal y no se aplica: no
-- hay "cambió un poquito" cuando el árbol es el mismo árbol.
--
-- La fila suelta de la RPC para un perfil es sólo su `own`; el número de la
-- pantalla es la suma del SUBÁRBOL de perfiles, por eso los recursivos.
--
-- A1) Hugo Ortiz → tiene que dar 687322.96
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
-- A2) Andres Arciniegas → tiene que dar 10702.14
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
--
-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN B · LA CALIBRACIÓN DEL PnL (junio 2026, contra los dos reports)
--
-- Una sola consulta devuelve las cinco filas calibradas. Los dos primeros son
-- los que se verificaron EXACTOS contra la pantalla; los otros tres se
-- contrastaron con el PNL Report y se anotan con ≈ porque se leyeron
-- redondeados del report.
--
--   millonariosteam2018@gmail.com  → pnl_crm ≈  148305.35 · com_lotes 45924.62
--   diegonanolopez@gmail.com       → pnl_crm =   -6336.14 · com_lotes  3399.39
--   inviertaconsonia@gmail.com     → pnl_crm ≈   -1088.26
--   starlin08_85@yahoo.es          → pnl_crm ≈  -16661.50
--   profitacademy777@gmail.com     → pnl_crm ≈    2742.46
--
-- Recordar el signo: negativo = los clientes de esa red PERDIERON (el bróker
-- ganó). La pantalla de comisiones lo muestra invertido; la RPC no.
--
-- select lower(trim(cp.email)) as perfil,
--        r.pnl_crm, r.com_lotes, r.usuarios_red
--   from hr_pnl_input_by_profile('71715987-5479-52c4-a990-c414fb3a9b36', '2026-06-01') r
--   join commercial_profiles cp on cp.id = r.profile_id
--  where lower(trim(cp.email)) in (
--          'millonariosteam2018@gmail.com',
--          'diegonanolopez@gmail.com',
--          'inviertaconsonia@gmail.com',
--          'starlin08_85@yahoo.es',
--          'profitacademy777@gmail.com'
--        )
--  order by 1;
--
-- B2) El control que descarta la fuente equivocada. Si alguien vuelve a
-- proponer `crm_ib_reward_daily.pnl` como PnL, esto lo cierra: para
-- millonariosteam2018 en agosto da del orden de -78.000.000 (el PNL del trader
-- repetido 4,9 veces, una por nivel de IB) contra el orden de magnitud del
-- report. No es un ajuste: es dinero contado cinco veces.
--
-- select sum(ib.pnl) as jamas_usar_esto_como_pnl
--   from crm_ib_reward_daily ib
--   join crm_user_snapshots cs
--     on cs.user_external_id = ib.ib_user_id
--    and cs.company_id = ib.company_id
--  where ib.company_id = '71715987-5479-52c4-a990-c414fb3a9b36'
--    and lower(trim(cs.username)) = 'millonariosteam2018'
--    and ib.day >= '2026-08-01' and ib.day < '2026-09-01';
--
-- B3) Contexto de la subred (lo que hace que el número sea auditable): el
-- tamaño que devuelve `usuarios_red` tiene que ser el mismo que sale de contar
-- el árbol a mano. Para diegonanolopez el triple match del report fue
-- -6336.14 / 8094.00 lotes / 19622 deals; los lotes y los deals se pueden
-- confirmar con la misma subred contra crm_daily_pnl_users:
--
-- select round(sum(d.pnl_usd), 2) as pnl_esperado_menos_6336_14,
--        round(sum(d.volume_lots), 2) as lotes_esperados_8094_00,
--        sum(d.deals_count) as deals_esperados_19622
--   from crm_daily_pnl_users d
--  where d.company_id = '71715987-5479-52c4-a990-c414fb3a9b36'
--    and d.utc_day >= '2026-06-01' and d.utc_day < '2026-07-01'
--    and d.user_external_id <> '(sin-dueño)'
--    and d.user_external_id in (
--      with recursive
--      enlace as materialized (
--        select hpr.uid, hpr.padre_uid
--          from hr_padres_resueltos('71715987-5479-52c4-a990-c414fb3a9b36') hpr
--      ),
--      raiz as (
--        select cs.user_external_id as uid
--          from crm_user_snapshots cs
--         where cs.company_id = '71715987-5479-52c4-a990-c414fb3a9b36'
--           and lower(trim(cs.username)) = 'diegonanolopez'
--         order by cs.user_external_id
--         limit 1
--      ),
--      red as (
--        select z.uid, 0 as d, array[z.uid] as camino from raiz z
--        union all
--        select e.uid, r.d + 1, r.camino || e.uid
--          from enlace e join red r on r.uid = e.padre_uid
--         where r.d < 25 and not (e.uid = any (r.camino))
--      )
--      select distinct red.uid from red
--    );
-- ─────────────────────────────────────────────────────────────────────────────
