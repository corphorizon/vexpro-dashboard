-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 093 — Agregados del cliente (Orion), para servírselos a Atlas
--
-- POR QUÉ
-- Decisión de Kevin (2026-08-25): Smart Dashboard pasa a ser el ÚNICO que se
-- conecta a Orion Mongo, y les sirve a los demás aplicativos lo que necesiten.
-- Hoy Atlas tiene su propio cron y sus propias credenciales contra la misma
-- base — la duplicación que ya evitamos con MySQL, pero en producción.
--
-- Atlas NUNCA ve un documento individual de `deposits` ni de `tradingaccounts`:
-- consume agregados por cliente. Esta tabla los guarda calculados.
--
-- ── NULL Y CERO NO SON LO MISMO, Y ACÁ ES CRÍTICO ──────────────────────────
-- Todas las columnas de agregado son NULABLES a propósito. En el modelo de
-- Atlas tienen `@default(0)` y no distinguen "no lo sé" de "es cero", y eso
-- rompe en silencio: un cliente con 4.000 dólares se muestra con 0 si el dato
-- no llegó, y el segmento "depositó y no tiene cuenta live" miente sin que
-- nadie lo note.
--
-- Es el mismo error que casi cometemos en la ficha del retiro entre "no operó"
-- y "no lo sabemos". Acá NULL significa "todavía no se calculó".
--
-- ── LO QUE NO ENTRA ────────────────────────────────────────────────────────
-- `tradingaccounts` tiene `masterPassword` e `investorPassword` EN TEXTO PLANO
-- en el origen (verificado el 2026-08-25 listando la colección). No se copian
-- ni se leen: la proyección que va a Mongo pide sólo lo necesario, así que ni
-- siquiera viajan por la red. Copiarlas multiplicaría los sitios desde los que
-- se puede robar acceso a 30.962 cuentas de trading.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.crm_customer_aggregates (
  company_id           uuid not null references public.companies(id) on delete cascade,
  user_external_id     text not null,
  email                text,

  -- Saldo de BILLETERA (wallets con walletType='BALANCE'). Es lo que Atlas
  -- llama `balanceUsd`. NO es el saldo de las cuentas de trading: eso viene de
  -- MT5 y son cosas distintas (ver el endpoint de trading-activity).
  wallet_balance       numeric,

  -- Dinero de la PLATAFORMA. Se calcula desde nuestro propio espejo
  -- (crm_deposits / crm_withdrawals), no desde Mongo: ya los tenemos y no
  -- tiene sentido pedirle dos veces lo mismo al broker.
  total_deposits       numeric,
  deposit_count        integer,
  last_deposit_at      timestamptz,
  total_withdrawals    numeric,

  -- Cuentas. `live_accounts_count` cuenta las que Orion marca real=true, o
  -- sea "cuántas abrió". Cuáles OPERAN lo sabe MT5, y es otra pregunta.
  accounts_count       integer,
  live_accounts_count  integer,
  social_accounts_count integer,

  -- Campos del perfil que La Base necesita y que no están en
  -- crm_user_snapshots.
  kyc_level            text,
  enabled_withdrawals  boolean,
  client_id            text,

  synced_at            timestamptz not null default now(),
  primary key (company_id, user_external_id)
);

create index if not exists idx_crm_aggregates_email
  on public.crm_customer_aggregates (company_id, email);

-- Para el cursor incremental del consumidor.
create index if not exists idx_crm_aggregates_synced
  on public.crm_customer_aggregates (company_id, synced_at asc);

alter table public.crm_customer_aggregates enable row level security;

drop policy if exists crm_customer_aggregates_select on public.crm_customer_aggregates;
create policy crm_customer_aggregates_select on public.crm_customer_aggregates
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

comment on table public.crm_customer_aggregates is
  'Agregados por cliente calculados desde Orion. Atlas nunca ve documentos individuales: consume esto. Columnas nulables A PROPOSITO: NULL es "no se calculo", 0 es "es cero" — confundirlos hace que un cliente con dinero se muestre en cero.';
comment on column public.crm_customer_aggregates.wallet_balance is
  'Saldo de BILLETERA (wallets walletType=BALANCE). NO es el saldo de cuentas de trading: eso viene de MT5 y son cosas distintas.';
comment on column public.crm_customer_aggregates.live_accounts_count is
  'Cuentas que Orion marca real=true, o sea cuantas ABRIO. Cuales OPERAN lo sabe MT5 y es otra pregunta.';
