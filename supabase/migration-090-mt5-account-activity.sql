-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 090 — Espejo de actividad de trading (MT5)
--
-- PARA QUÉ
-- Responder, en la revisión de retiros, la pregunta que hoy no podemos:
-- ¿este cliente OPERÓ, o depositó y pidió el retiro sin tocar el mercado?
--
-- POR QUÉ UN ESPEJO Y NO CONSULTAR EN VIVO
-- mt5_deals tiene 68,4 MILLONES de filas en la base de PRODUCCIÓN del broker.
-- Consultarla en cada carga de pantalla es inaceptable para ellos y frágil
-- para nosotros. Mismo patrón que Orion: un sync trae agregados, las pantallas
-- leen nuestra base.
--
-- ── LO QUE ESTA TABLA GUARDA Y LO QUE NO (medido el 2026-08-24) ─────────────
-- Los índices reales de mt5_deals son PRIMARY(Deal), Timestamp, y dos
-- compuestos; el útil acá es (Login, TimeMsc, Entry, Action, Profit, Storage,
-- Commission). Agregar SÓLO esas columnas para 177 cuentas tarda 345 ms.
-- Agregar además `Volume` —que NO está en el índice— tarda 13.221 ms: 38 veces
-- más, porque obliga a ir a la fila. Por eso NO guardamos volumen acá.
--
-- No es una pérdida: el CRM ya trae `totalVolume` y `personalVolume` por
-- cliente. Si algún día hace falta el volumen POR CUENTA, hay que pedirle al
-- hosting del broker un índice que lo cubra — no forzar la consulta.
--
-- ── DOS TRAMPAS QUE ESTE ESQUEMA EVITA ─────────────────────────────────────
--  1. `ClientID` NO sirve para unir con el CRM: sólo tiene 18 valores
--     distintos en 26.422 cuentas y casi todas valen 0, así que un join por
--     ahí casaría con TODA la base. La llave es el CORREO, normalizado.
--  2. Un cliente tiene VARIAS cuentas (26.422 cuentas para 11.390 correos).
--     La fila es por cuenta; la suma por cliente se hace al leer.
--
-- Las cuentas DEMO se marcan y se excluyen del cálculo: operar en demo no es
-- evidencia de haber operado el dinero depositado, y confundirlas sería
-- exactamente el error que este módulo existe para evitar.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.mt5_account_activity (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,

  login           bigint not null,
  -- Normalizado lower(trim): la unión con el CRM se hace por acá.
  email           text,
  group_name      text,
  -- Group que empieza por 'demo'. Se guarda para poder AUDITAR la exclusión,
  -- no para excluir en silencio.
  is_demo         boolean not null default false,

  -- Agregados que salen del índice (ver cabecera). deals_count cuenta sólo
  -- Entry in (0,1): entradas y salidas de mercado, no los ajustes de balance.
  deals_count     bigint not null default 0,
  profit          numeric,
  commission      numeric,
  storage         numeric,
  first_deal_at   timestamptz,
  last_deal_at    timestamptz,

  -- Foto de mt5_users, útil para el contexto del analista.
  account_balance numeric,
  registration_at timestamptz,

  synced_at       timestamptz not null default now(),
  constraint mt5_account_activity_unique unique (company_id, login)
);

-- La consulta natural: "las cuentas de este cliente".
create index if not exists idx_mt5_activity_email
  on public.mt5_account_activity (company_id, email);

-- Y la de "quién operó últimamente".
create index if not exists idx_mt5_activity_last_deal
  on public.mt5_account_activity (company_id, last_deal_at desc nulls last);

alter table public.mt5_account_activity enable row level security;

drop policy if exists mt5_account_activity_select on public.mt5_account_activity;
create policy mt5_account_activity_select on public.mt5_account_activity
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

comment on table public.mt5_account_activity is
  'Espejo de actividad de trading por cuenta MT5. Solo lectura: lo reescribe el sync. Sin volumen a propósito (no esta indexado en el broker: 38x mas lento) — el volumen por cliente viene del CRM.';
comment on column public.mt5_account_activity.email is
  'Correo normalizado. Es la UNICA llave valida contra el CRM: ClientID tiene 18 valores distintos en 26.422 cuentas y no sirve.';
comment on column public.mt5_account_activity.is_demo is
  'Cuenta demo. Operar en demo NO es evidencia de haber operado el dinero depositado; se marca para poder auditar la exclusion en vez de esconderla.';
