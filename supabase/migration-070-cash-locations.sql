-- Migración 070 — Dónde está el dinero: unidades de negocio y tipo de ubicación
--
-- Pedido de Kevin: en Balances poder decir DÓNDE está la plata (una wallet, una
-- cuenta bancaria, prestada a alguien) y a qué unidad de negocio pertenece,
-- todo en UNA sola pantalla.
--
-- POR QUÉ NO HAY TABLA NUEVA DE "UBICACIONES"
-- `channel_configs` ya es exactamente eso: una fila por lugar donde hay plata,
-- con su etiqueta, su orden y si se muestra. Y `channel_ledger_entries` ya le
-- lleva el libro con saldo corrido a cada una, con RPCs, PDF y pantalla
-- probados. Crear una tabla paralela habría dejado dos listas de lo mismo —
-- el modo de falla número uno de este repo. Se extiende lo que existe.
--
-- LOS PRÉSTAMOS NO SON UN GASTO
-- En la contabilidad de Horizon salieron $122.479 en préstamos y volvieron
-- $74.128: hay $48.351 afuera que son plata de la empresa. Hoy no aparecen en
-- ningún lado — no están en caja porque salieron, y no son egreso porque se
-- van a devolver. El tipo 'loan' los deja contados y a la vez separados de lo
-- líquido, que es la distinción que importa cuando hay que pagar algo mañana.

-- ── Unidades de negocio ─────────────────────────────────────────────────────
-- El flag de fondo vive ACÁ y no en cada ubicación: Kevin lo pidió por unidad
-- ("que se pueda elegir si una unidad de negocio suma o está por aparte"), y
-- ponerlo por ubicación permitiría que dos wallets de la misma unidad
-- discreparan sobre si su plata es del fondo.
create table if not exists public.business_units (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  name           text not null,
  /** true = su saldo entra en el fondo general (el "ahorro real"). */
  counts_to_fund boolean not null default true,
  is_active      boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (company_id, name)
);

create index if not exists business_units_company_idx
  on public.business_units (company_id, sort_order);

alter table public.business_units enable row level security;

drop policy if exists business_units_select on public.business_units;
create policy business_units_select on public.business_units
  for select using (
    company_id in (select company_id from public.company_users where user_id = (select auth.uid()))
  );

drop policy if exists business_units_write on public.business_units;
create policy business_units_write on public.business_units
  for all using (
    company_id in (
      select company_id from public.company_users
      where user_id = (select auth.uid()) and role in ('admin', 'auditor')
    )
  );

-- ── Dónde está la plata ─────────────────────────────────────────────────────
alter table public.channel_configs
  add column if not exists location_type text not null default 'gateway',
  add column if not exists business_unit_id uuid references public.business_units(id) on delete set null,
  /** Para 'loan': a quién se le prestó. Para 'bank': el banco. */
  add column if not exists holder text;

alter table public.channel_configs
  drop constraint if exists channel_configs_location_type_check;
alter table public.channel_configs
  add constraint channel_configs_location_type_check
  check (location_type in ('gateway', 'wallet', 'bank', 'cash', 'trading', 'loan'));

comment on column public.channel_configs.location_type is
  'Dónde está la plata. gateway = pasarela con API (Coinsbuy/UniPayment). loan = prestada: es de la empresa pero no es líquida.';
comment on column public.channel_configs.business_unit_id is
  'Unidad de negocio dueña de esta ubicación. NULL = no asignada.';

-- Las pasarelas con API conservan su tipo; lo cargado a mano hasta hoy son
-- wallets (Trust Wallet, Wallet Retiro FairPay, cuentas de exchange).
update public.channel_configs
   set location_type = 'wallet'
 where channel_type = 'manual' and location_type = 'gateway';
