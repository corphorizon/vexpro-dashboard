-- Migración 071 — Un lugar puede pertenecer a varias unidades de negocio
--
-- Decisión de Kevin (2026-08-09): una wallet compartida se reparte entre
-- unidades CON PORCENTAJE, no en partes iguales ni forzando una sola dueña.
-- Así el desglose por unidad y el fondo suman exactamente lo mismo que el
-- total, que es lo que hace confiable un balance.
--
-- Tabla puente y no una columna más en channel_configs: el porcentaje es un
-- atributo de la RELACIÓN entre ubicación y unidad, no de ninguna de las dos.
--
-- `channel_configs.business_unit_id` NO se elimina: sigue siendo la unidad
-- principal y el fallback para las ubicaciones sin filas acá. Migrarlo a la
-- fuerza habría roto las pantallas que ya lo leen.
--
-- El CHECK acota cada parte a 0..1, pero la SUMA por ubicación no se fuerza en
-- la base a propósito: durante una reasignación hay estados intermedios que no
-- suman 1, y bloquearlos obligaría a borrar todo antes de reasignar. La UI
-- valida y avisa.

create table if not exists public.location_business_units (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  channel_key      text not null,
  business_unit_id uuid not null references public.business_units(id) on delete cascade,
  share            numeric(6,4) not null default 1
                     check (share >= 0 and share <= 1),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, channel_key, business_unit_id)
);

create index if not exists location_business_units_lookup_idx
  on public.location_business_units (company_id, channel_key);

alter table public.location_business_units enable row level security;

drop policy if exists lbu_select on public.location_business_units;
create policy lbu_select on public.location_business_units
  for select using (
    company_id in (select company_id from public.company_users where user_id = (select auth.uid()))
  );

drop policy if exists lbu_write on public.location_business_units;
create policy lbu_write on public.location_business_units
  for all using (
    company_id in (
      select company_id from public.company_users
      where user_id = (select auth.uid()) and role in ('admin', 'auditor')
    )
  );

insert into public.location_business_units (company_id, channel_key, business_unit_id, share)
select company_id, channel_key, business_unit_id, 1
  from public.channel_configs
 where business_unit_id is not null
on conflict (company_id, channel_key, business_unit_id) do nothing;

comment on table public.location_business_units is
  'Qué unidades de negocio son dueñas de cada ubicación y en qué proporción. Sin filas, manda channel_configs.business_unit_id.';
