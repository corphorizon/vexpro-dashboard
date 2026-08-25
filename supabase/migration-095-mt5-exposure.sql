-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 095 — Exposición abierta del bróker (MT5)
--
-- PARA QUÉ
-- Responder "cuánto riesgo tenemos vivo AHORA", que hoy no se ve en ningún
-- lado. Medido el 2026-08-25: 3.510 posiciones abiertas de 824 cuentas.
--
-- POR QUÉ UNA FOTO Y NO CONSULTA EN VIVO
-- `mt5_positions` se consulta en 271 ms, pero la conexión sale por el túnel
-- SOCKS5 y sólo abrirla tarda ~3,5 s. Una pantalla que consultara en vivo
-- tardaría cuatro segundos en pintar. Se guarda una foto cada 15 minutos: para
-- una vista de riesgo, quince minutos de antigüedad es información útil, y la
-- pantalla dice de cuándo es.
--
-- ── EL DINERO NO SE SUMA ENTRE FAMILIAS ────────────────────────────────────
-- Misma regla que en el resto del módulo, y acá muerde fuerte: las cuentas
-- Cent están denominadas EN CENTAVOS. Medido, el flotante abierto por familia:
--
--     Cent        1.940 posiciones   -724.331  ← son unos -7.243 dólares
--     Broker      1.383 posiciones     15.298
--     Copy          243 posiciones     14.723
--     PropFirm       28 posiciones     17.584  ← capital virtual de desafío
--
-- Sumarlas daría -676.789 "dólares" que no existen. Por eso cada fila lleva su
-- unidad y NUNCA se guarda un total agregado.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.mt5_exposure_snapshots (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  snapshot_at   timestamptz not null,

  -- Segundo tramo del Group de MT5: `real\Cent\STP` → `Cent`.
  family        text not null,
  symbol        text not null,

  positions     integer not null default 0,
  accounts      integer not null default 0,

  -- Lotes. `Volume` viene en diezmilésimas de lote en MT5.
  long_lots     numeric,
  short_lots    numeric,
  /** Largo − corto. El signo dice de qué lado está el cliente. */
  net_lots      numeric,

  -- Flotante y swap EN LA UNIDAD DE LA FAMILIA (ver cabecera).
  floating      numeric,
  storage       numeric,
  unit          text not null check (unit in ('cents','account_currency')),
  /** PropFirm es capital de desafío, no dinero real de nadie. */
  is_virtual    boolean not null default false,

  constraint mt5_exposure_unique unique (company_id, snapshot_at, family, symbol)
);

-- La consulta natural: "la foto más reciente".
create index if not exists idx_mt5_exposure_latest
  on public.mt5_exposure_snapshots (company_id, snapshot_at desc);

alter table public.mt5_exposure_snapshots enable row level security;

drop policy if exists mt5_exposure_select on public.mt5_exposure_snapshots;
create policy mt5_exposure_select on public.mt5_exposure_snapshots
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

comment on table public.mt5_exposure_snapshots is
  'Foto de la exposicion abierta cada 15 min. El dinero va POR FAMILIA con su unidad y NUNCA sumado: las cuentas Cent estan en centavos y PropFirm es capital virtual.';
comment on column public.mt5_exposure_snapshots.net_lots is
  'Largo menos corto. El signo dice de que lado esta el cliente; el broker esta del lado contrario.';
