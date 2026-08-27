-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 096 — Los llamados de atención de RRHH dejan de vivir en la cabeza
-- de Daniela
--
-- QUÉ SE PIDIÓ (reunión con Daniela Puello, RRHH, 27/08/2026)
-- Una pestaña de warnings por perfil comercial —sobre todo BDM GLOBAL—, mensual,
-- con TRES motivos y nada más: «uno depósito net deposit, el segundo es creación
-- de líneas nuevas y el tercero es creación de equipo». Y poder ver cuántos
-- acumula cada uno, «cuando tienen dos o tres».
--
-- POR QUÉ `month` ES UNA FECHA Y NO UN period_id
-- Un warning es del MES CALENDARIO, no del período contable. Los períodos se
-- cierran (migración 061) y un período cerrado congela sus filas; un llamado de
-- atención cargado tarde no puede quedar bloqueado por eso. Además hay meses sin
-- período creado. Se guarda el día 1 y un CHECK lo obliga, así que
-- `2026-07-01` es la ÚNICA representación posible de julio: sin eso, la clave
-- única de abajo dejaría entrar el mismo warning tantas veces como días tiene
-- el mes.
--
-- POR QUÉ EL ÚNICO (company_id, profile_id, month, motive)
-- El motivo net_deposit lo va a sugerir el sistema todos los meses mirando el
-- CRM. Sin la clave, cada visita a la pestaña podía terminar en un warning
-- repetido para el mismo hecho. Con ella, confirmar dos veces es idempotente:
-- el segundo INSERT choca y no pasa nada.
--
-- LAS METAS NO SE HARDCODEAN
-- Daniela dictó la tabla vigente: «salario de mil dólares, el mínimo son 30 mil;
-- de 1.500, 40 mil; y 2.000, 50 mil». Es una regla de negocio que cambia con el
-- tiempo y con la empresa (el dashboard es white-label), así que vive en una
-- tabla por empresa y no en una constante del cliente. La semilla son esos tres
-- escalones para toda empresa que ya tenga fuerza comercial cargada.
--
-- EL PRIMER MES NO CUENTA — y no se guarda acá
-- «El primer mes se les paga igual, es el riesgo que corre la empresa». La
-- exención se calcula contra `commercial_profiles.hire_date` en el momento de
-- sugerir; no es un dato de esta tabla. Un warning que igual se decidió cargar a
-- mano en el primer mes es una decisión humana y la DB no la discute.
--
-- EL SISTEMA SUGIERE, LA PERSONA FIRMA
-- No hay trigger ni cron que inserte warnings. La sugerencia se calcula al vuelo
-- y alguien la confirma; por eso `created_by_name` es texto y no una FK: es el
-- nombre que hay que poder leer dentro de dos años aunque ese usuario ya no
-- exista (mismo criterio que `periods.closed_by_name`, migración 061).
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. Llamados de atención ─────────────────────────────────────────────────

create table if not exists public.hr_warnings (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id),
  profile_id      uuid not null references public.commercial_profiles(id) on delete cascade,
  month           date not null,
  motive          text not null check (motive in ('net_deposit', 'new_lines', 'team_creation')),
  detail          text,
  created_by_name text,
  created_at      timestamptz not null default now(),
  constraint hr_warnings_month_is_first_day check (extract(day from month) = 1),
  constraint hr_warnings_unico unique (company_id, profile_id, month, motive)
);

comment on table public.hr_warnings is
  'Llamados de atención mensuales a un perfil comercial. Tres motivos cerrados '
  '(net_deposit, new_lines, team_creation). `month` es siempre el día 1 del mes '
  'calendario. Único por (empresa, perfil, mes, motivo): confirmar dos veces la '
  'misma sugerencia no duplica.';

comment on column public.hr_warnings.created_by_name is
  'Nombre de quien lo confirmó, en texto. No es FK a propósito: tiene que seguir '
  'siendo legible aunque el usuario se dé de baja.';

-- La pantalla pregunta siempre lo mismo: "los warnings de esta empresa, de este
-- mes hacia atrás, agrupados por perfil". El índice cubre ese acceso; la clave
-- única ya cubre la búsqueda por perfil exacto.
create index if not exists hr_warnings_company_month_idx
  on public.hr_warnings (company_id, month desc);

alter table public.hr_warnings enable row level security;

-- Lectura: cualquiera de la empresa que además pase el portón de RRHH
-- (`auth_is_hr_reader`, migración 064, política restrictiva más abajo).
create policy hr_warnings_select on public.hr_warnings
  for select using (company_id in (select auth_company_ids()));

create policy hr_warnings_insert on public.hr_warnings
  for insert with check (
    company_id in (
      select company_id from public.company_users
       where user_id = auth.uid() and role = any(array['admin', 'hr'])
    )
  );

create policy hr_warnings_delete on public.hr_warnings
  for delete using (
    company_id in (
      select company_id from public.company_users
       where user_id = auth.uid() and role = any(array['admin', 'hr'])
    )
  );

-- Sin UPDATE a propósito: un llamado de atención se carga o se borra, no se
-- reescribe. Editarle el motivo a uno viejo cambiaría la historia que Daniela
-- usa para decidir un despido.

-- Mismo portón restrictivo que employees/commercial_profiles: un `invitado` sin
-- el módulo RRHH no puede leer quién tiene warnings abriendo la pestaña Network.
drop policy if exists hr_warnings_hr_role_gate on public.hr_warnings;
create policy hr_warnings_hr_role_gate on public.hr_warnings
  as restrictive for select to authenticated
  using (public.auth_is_hr_reader());

-- ── 2. Metas de net deposit por salario ─────────────────────────────────────

create table if not exists public.hr_net_deposit_goals (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id),
  salary           numeric(14,2) not null check (salary >= 0),
  min_net_deposit  numeric(14,2) not null check (min_net_deposit >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint hr_net_deposit_goals_unico unique (company_id, salary)
);

comment on table public.hr_net_deposit_goals is
  'Escalones de meta: a tal salario mensual le corresponde tal net deposit mínimo. '
  'Registro único de la regla — el cliente NO la lleva hardcodeada. Un salario que '
  'no cae exacto en un escalón usa el escalón más alto que no lo supere.';

alter table public.hr_net_deposit_goals enable row level security;

create policy hr_net_deposit_goals_select on public.hr_net_deposit_goals
  for select using (company_id in (select auth_company_ids()));

create policy hr_net_deposit_goals_write on public.hr_net_deposit_goals
  for all using (
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

drop policy if exists hr_net_deposit_goals_hr_role_gate on public.hr_net_deposit_goals;
create policy hr_net_deposit_goals_hr_role_gate on public.hr_net_deposit_goals
  as restrictive for select to authenticated
  using (public.auth_is_hr_reader());

-- Semilla: los tres escalones que dictó Daniela, para toda empresa que ya tenga
-- fuerza comercial cargada. Se siembra por SELECT y no con ids escritos a mano
-- para que la migración sirva igual en staging, en prod y en un tenant nuevo.
insert into public.hr_net_deposit_goals (company_id, salary, min_net_deposit)
select c.id, g.salary, g.meta
from public.companies c
cross join (values (1000::numeric, 30000::numeric),
                   (1500::numeric, 40000::numeric),
                   (2000::numeric, 50000::numeric)) as g(salary, meta)
where exists (select 1 from public.commercial_profiles p where p.company_id = c.id)
on conflict (company_id, salary) do nothing;

commit;
