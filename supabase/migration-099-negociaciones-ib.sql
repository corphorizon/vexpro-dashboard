-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 099 — Negociaciones con IBs (aparte de las de perfiles comerciales)
--
-- QUÉ PIDIÓ KEVIN (2026-08-27, textual)
-- «Me gustaría crear en esa sección algo para también tener negociaciones de IB
-- por aparte, normalmente son negociaciones de PNL o Net Deposit, necesitaría
-- tener la info completa de ellos, el net deposit de ellos y su red, el PNL, la
-- cantidad de lotes que se les pagaron y cuánto se les pagó».
--
-- ── POR QUÉ UNA TABLA NUEVA Y NO `commercial_negotiations` ─────────────────
-- `commercial_negotiations` apunta con FK a `commercial_profiles`: es la gente
-- de la ESTRUCTURA COMERCIAL (BDM, heads, sales managers) — 126 filas. Un IB es
-- un CLIENTE del CRM que refiere gente: 702 con premios pagados sobre 21.196
-- usuarios espejados, y sólo 114 de los 1.793 sponsors distintos del CRM son
-- perfiles comerciales (medido en la migración 097). O sea: el IB típico NO
-- tiene perfil comercial y no cabe en esa FK ni forzándolo. Kevin además lo
-- pidió literalmente «por aparte». Esta tabla apunta al CRM por
-- `user_external_id` y no toca la otra.
--
-- ── POR QUÉ `user_external_id` Y NO UNA FK ────────────────────────────────
-- `crm_user_snapshots` es un ESPEJO: el cron lo reescribe y una fila puede
-- desaparecer si el CRM da de baja al usuario. Una FK haría que un
-- resincronizado borrara negociaciones firmadas, o que el cron fallara. Se
-- guarda el id externo + el email + el username CONGELADOS al momento del alta:
-- si mañana el IB se cambia el username, la negociación sigue diciendo con
-- quién se firmó. La pantalla cruza por `user_external_id`, que es el id de
-- Orion y no cambia.
--
-- ── EL `user_external_id` DEL CRM ES EL `ib_user_id` DE LOS PREMIOS ────────
-- Verificado sobre Vex Pro el 2026-08-27, no asumido: las 37.166 filas de
-- `crm_ib_reward_daily` (702 IB distintos, 777.515,99 USD de comisión
-- acumulada) matchean UNA fila de `crm_user_snapshots` — 37.166 de 37.166,
-- 702 de 702, el 100% de la comisión. Por eso la pantalla puede pegar el perfil
-- completo del IB a su producción sin ningún fallback.
--
-- ── LOS TÉRMINOS SON TEXTO LIBRE A PROPÓSITO ──────────────────────────────
-- Kevin dijo «NORMALMENTE son negociaciones de PNL o Net Deposit». `deal_type`
-- fija esas dos porque son las que hay que poder filtrar y contar, y el resto
-- —el escalonado, el mínimo, la excepción del primer mes— vive en `terms`, que
-- es texto. Modelar hoy un esquema de escalones sería inventar una estructura
-- que nadie describió todavía; `pct` y `target_amount` quedan opcionales para
-- el caso simple («20% del PNL», «meta 50.000 de net deposit») sin obligar a
-- nadie a llenarlos.
--
-- ── UNA SOLA NEGOCIACIÓN ACTIVA POR IB Y TIPO ─────────────────────────────
-- El índice único parcial no es burocracia: dos filas activas de PNL para el
-- mismo IB casi siempre son el mismo trato cargado dos veces, y la pantalla
-- mostraría los mismos números duplicados sin que nadie sepa cuál rige. Para
-- cambiar condiciones se cierra la vieja (`status='closed'`) y se abre otra:
-- así queda la historia, que es lo que hace falta para discutir un pago viejo.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.ib_negotiations (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  -- El id de Orion. Sin FK: `crm_user_snapshots` es un espejo. Ver cabecera.
  user_external_id text not null,
  -- Congelados al alta: con quién se firmó, aunque el CRM le cambie los datos.
  ib_email         text,
  ib_username      text,
  deal_type        text not null check (deal_type in ('pnl', 'net_deposit')),
  terms            text,
  -- Porcentaje del PNL / del net deposit, cuando el trato es un porcentaje
  -- simple. NULL = el trato no se resume en un número y está en `terms`.
  pct              numeric(7,4) check (pct is null or (pct >= 0 and pct <= 100)),
  -- Meta o piso pactado en USD, cuando lo hay.
  target_amount    numeric(16,2) check (target_amount is null or target_amount >= 0),
  status           text not null default 'active' check (status in ('active', 'closed')),
  starts_on        date,
  ends_on          date,
  notes            text,
  -- Texto y no FK, mismo criterio que `hr_warnings.created_by_name` y
  -- `periods.closed_by_name`: dentro de dos años hay que poder leer quién la
  -- cargó aunque ese usuario ya no exista.
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ib_negotiations_fechas_coherentes
    check (starts_on is null or ends_on is null or ends_on >= starts_on)
);

comment on table public.ib_negotiations is
  'Negociaciones con IBs del CRM (clientes que refieren), separadas de '
  'commercial_negotiations, que es de perfiles comerciales. Apunta al CRM por '
  'user_external_id (el id de Orion, que es el mismo ib_user_id de '
  'crm_ib_reward_daily) sin FK, porque crm_user_snapshots es un espejo que el '
  'cron reescribe.';

comment on column public.ib_negotiations.terms is
  'Términos en texto libre. deal_type fija sólo las dos familias que Kevin '
  'nombró (PNL / net deposit); el detalle del trato va acá.';

-- Una activa por IB y tipo. Cerrar y abrir otra es el camino para cambiar
-- condiciones — así queda la historia.
create unique index if not exists ib_negotiations_una_activa
  on public.ib_negotiations (company_id, user_external_id, deal_type)
  where status = 'active';

-- La pantalla siempre pide "las de esta empresa, las activas primero".
create index if not exists ib_negotiations_company_status_idx
  on public.ib_negotiations (company_id, status, updated_at desc);

drop trigger if exists ib_negotiations_updated_at on public.ib_negotiations;
create trigger ib_negotiations_updated_at
  before update on public.ib_negotiations
  for each row execute function public.set_updated_at();

alter table public.ib_negotiations enable row level security;

-- Lectura: pertenecer a la empresa + pasar el portón de RRHH (política
-- restrictiva de abajo, igual que hr_warnings / employees).
drop policy if exists ib_negotiations_select on public.ib_negotiations;
create policy ib_negotiations_select on public.ib_negotiations
  for select using (company_id in (select public.auth_company_ids()));

drop policy if exists ib_negotiations_insert on public.ib_negotiations;
create policy ib_negotiations_insert on public.ib_negotiations
  for insert with check (
    company_id in (
      select company_id from public.company_users
       where user_id = auth.uid() and role = any(array['admin', 'hr'])
    )
  );

-- A diferencia de hr_warnings, acá SÍ hay UPDATE: una negociación se renegocia
-- y se cierra, no es un hecho histórico inmutable como un llamado de atención.
drop policy if exists ib_negotiations_update on public.ib_negotiations;
create policy ib_negotiations_update on public.ib_negotiations
  for update using (
    company_id in (
      select company_id from public.company_users
       where user_id = auth.uid() and role = any(array['admin', 'hr'])
    )
  ) with check (
    company_id in (
      select company_id from public.company_users
       where user_id = auth.uid() and role = any(array['admin', 'hr'])
    )
  );

drop policy if exists ib_negotiations_delete on public.ib_negotiations;
create policy ib_negotiations_delete on public.ib_negotiations
  for delete using (
    company_id in (
      select company_id from public.company_users
       where user_id = auth.uid() and role = any(array['admin', 'hr'])
    )
  );

drop policy if exists ib_negotiations_hr_role_gate on public.ib_negotiations;
create policy ib_negotiations_hr_role_gate on public.ib_negotiations
  as restrictive for select to authenticated
  using (public.auth_is_hr_reader());

-- ─────────────────────────────────────────────────────────────────────────────
-- LA RED DEL IB: LA CADENA DE SPONSORS AL REVÉS
--
-- Ojo con esto, porque es lo INVERSO de las migraciones 097/098. Allá se SUBE
-- desde un cliente hasta el primer perfil comercial que aparezca. Acá se BAJA:
-- desde el username del IB, todos los clientes que cuelgan de él por la cadena
-- de sponsors, a cualquier profundidad. No se puede reusar aquella lógica ni
-- dándola vuelta: allá la cadena se CORTA en el primer comercial (para atribuir
-- al más cercano) y acá no se corta nunca, porque la red de un IB incluye a los
-- sub-IB y a la gente de los sub-IB — que es exactamente por lo que cobra.
--
-- ── PROTECCIÓN CONTRA CICLOS: LA CLÁUSULA `CYCLE`, NO UN ARRAY A MANO ──────
-- Un sponsor circular (A patrocina a B que patrocina a A) cuelga un CTE
-- recursivo para siempre. Hoy no hay ninguno —medido: 21.196 usuarios, 0
-- usernames duplicados, 0 autosponsors, 96 con sponsor que no existe en el
-- espejo (esos simplemente no cuelgan de nadie)— pero el dato viene de un CRM
-- de terceros y lo que hoy no pasa mañana sí.
--
-- Se usa la cláusula `CYCLE ... SET ... USING` del estándar (Postgres 14+) y no
-- el `array[] || un` + `not any(path)` a mano, y la razón es MEDIDA, no
-- estética: sobre los 8 IB más grandes de Vex Pro (39.781 filas de subárbol,
-- 17 niveles de profundidad) el array a mano tardó 4,40 s y la cláusula CYCLE
-- 0,61 s — siete veces menos. Un array de 17 elementos por fila que se copia en
-- cada nivel es caro; la cláusula lo hace en C.
--
-- El tope de 25 saltos queda igual, como segundo cinturón: si alguna vez la
-- cláusula no alcanzara, la consulta termina igual en vez de colgar la
-- pantalla. La profundidad real hoy es 17.
--
-- ── LOS DOS SON SECURITY INVOKER (por omisión) ────────────────────────────
-- Igual que hr_net_deposit_by_profile y hr_ib_production_by_profile: filtran
-- por `p_company_id` en cada rama y se revocan de public/anon. El dashboard las
-- llama con el cliente admin; `authenticated` queda para poder probarlas desde
-- el SQL editor con una sesión real.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Los números de la red, para la LISTA ────────────────────────────────
-- Toma TODOS los IB negociados de una (`p_usernames`) y no uno por uno: la
-- lista de negociaciones los muestra juntos, y una llamada por fila serían N
-- recorridos del mismo árbol. Con 8 raíces grandes solapadas tarda 0,61 s.

create or replace function public.crm_ib_network_stats(
  p_company_id uuid,
  p_usernames  text[],
  p_month      date
)
returns table (
  root_username  text,
  network_size   bigint,
  network_depth  int,
  network_net    numeric,
  network_movers bigint,
  own_net        numeric
)
language sql
stable
set search_path to 'public'
as $function$
  with recursive
  s as (
    select user_external_id,
           lower(trim(username)) as un,
           nullif(lower(trim(sponsor_username)), '') as sun
      from crm_user_snapshots
     where company_id = p_company_id
  ),
  red as (
    -- d = 0 es el IB mismo: se lleva su propio net deposit aparte, porque «el
    -- net deposit de ellos Y su red» son dos números distintos y sumarlos
    -- escondería que el IB personalmente retiró más de lo que depositó.
    select s.un as root, s.user_external_id, s.un, 0 as d
      from s
     where s.un = any (select lower(trim(u)) from unnest(coalesce(p_usernames, '{}'::text[])) u)
    union all
    select r.root, s.user_external_id, s.un, r.d + 1
      from s join red r on s.sun = r.un
     where r.d < 25
  ) cycle un set es_ciclo using ruta,
  -- Mismos criterios que hr_net_deposit_by_profile (migración 097): depósitos
  -- `completed` por deposit_at, retiros `approved` por processed_at. Los
  -- `cancelled` y `pending` NO son plata que entró — contarlos multiplicaba el
  -- net deposit por seis.
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
    select r.root, r.d,
           coalesce(dep.v, 0) - coalesce(wd.v, 0) as neto,
           (dep.v is not null or wd.v is not null) as movio
      from red r
      left join dep on dep.user_external_id = r.user_external_id
      left join wd  on  wd.user_external_id = r.user_external_id
     where not r.es_ciclo
  )
  select m.root,
         count(*) filter (where m.d > 0),
         coalesce(max(m.d), 0)::int,
         round(coalesce(sum(m.neto) filter (where m.d > 0), 0), 2),
         count(*) filter (where m.d > 0 and m.movio),
         round(coalesce(sum(m.neto) filter (where m.d = 0), 0), 2)
    from mov m
   group by m.root;
$function$;

comment on function public.crm_ib_network_stats(uuid, text[], date) is
  'Tamano y net deposit del SUBARBOL de sponsors de cada IB (la cadena hacia '
  'ABAJO, al reves de hr_net_deposit_by_profile) mas el net deposit propio del '
  'IB, para un mes. Protegida contra ciclos con la clausula CYCLE y un tope de '
  '25 saltos.';

revoke all on function public.crm_ib_network_stats(uuid, text[], date) from public, anon;
grant execute on function public.crm_ib_network_stats(uuid, text[], date) to authenticated, service_role;

-- ── 2. Los miembros de UNA red, para el DETALLE ────────────────────────────
-- Se ordena por net deposit del mes y se corta con `p_limit`: la red de un IB
-- grande son 17.065 personas (medido: hugoortiz, Vex Pro), y devolverlas todas
-- a un navegador sería mandar megabytes para que alguien mire las diez primeras.

create or replace function public.crm_ib_network_members(
  p_company_id uuid,
  p_username   text,
  p_month      date,
  p_limit      int default 50
)
returns table (
  user_external_id text,
  username         text,
  email            text,
  country          text,
  status           text,
  depth            int,
  deposits         numeric,
  withdrawals      numeric,
  net              numeric
)
language sql
stable
set search_path to 'public'
as $function$
  with recursive
  s as (
    select user_external_id,
           lower(trim(username)) as un,
           nullif(lower(trim(sponsor_username)), '') as sun
      from crm_user_snapshots
     where company_id = p_company_id
  ),
  red as (
    select s.user_external_id, s.un, 0 as d
      from s where s.un = lower(trim(p_username))
    union all
    select s.user_external_id, s.un, r.d + 1
      from s join red r on s.sun = r.un
     where r.d < 25
  ) cycle un set es_ciclo using ruta,
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
  )
  select r.user_external_id,
         u.username, u.email, u.country, u.status,
         r.d::int,
         round(coalesce(dep.v, 0), 2),
         round(coalesce(wd.v, 0), 2),
         round(coalesce(dep.v, 0) - coalesce(wd.v, 0), 2)
    from red r
    join crm_user_snapshots u
      on u.company_id = p_company_id and u.user_external_id = r.user_external_id
    left join dep on dep.user_external_id = r.user_external_id
    left join wd  on  wd.user_external_id = r.user_external_id
   where r.d > 0            -- el IB mismo no es parte de su propia red
     and not r.es_ciclo
     and (dep.v is not null or wd.v is not null)  -- sólo los que movieron plata
   order by abs(coalesce(dep.v, 0) - coalesce(wd.v, 0)) desc
   limit greatest(1, least(coalesce(p_limit, 50), 500));
$function$;

comment on function public.crm_ib_network_members(uuid, text, date, int) is
  'Los miembros de la red de UN IB que movieron plata en el mes, ordenados por '
  'monto absoluto y topeados (la red de un IB grande son 17.000 personas). '
  'Excluye al IB mismo.';

revoke all on function public.crm_ib_network_members(uuid, text, date, int) from public, anon;
grant execute on function public.crm_ib_network_members(uuid, text, date, int) to authenticated, service_role;

commit;
