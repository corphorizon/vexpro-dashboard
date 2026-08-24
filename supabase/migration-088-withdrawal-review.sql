-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 088 — Módulo de Revisión de Retiros (espejo del CRM + decisiones)
--
-- POR QUÉ ESPEJAMOS EN VEZ DE CONSULTAR EL CRM EN VIVO:
-- el dashboard corre en Vercel serverless; abrir Mongo del broker en cada
-- carga de pantalla es lento, frágil y le mete carga a su producción. Mismo
-- patrón que las pasarelas: un cron trae los datos, las pantallas leen NUESTRA
-- base. Si el CRM se cae, el módulo sigue funcionando con el último dato bueno.
--
-- HALLAZGOS DE LA DATA REAL (analítica 2026-08-24, 13.524 retiros / 39.413
-- depósitos de Vex Pro) que este esquema codifica:
--
--  1. `deposits.depositValue` ESTÁ CORRUPTO (suma de cancelados = 5,7e16; máx
--     1,4e16). Es intención del usuario, no dinero. El importe real es
--     `amountPaid`. Por eso amount_paid es la columna de dinero y deposit_value
--     queda aparte, sólo informativa.
--  2. `withdrawals.totalDepositLifetime/totalWithdrawLifetime` NO sirven para
--     el score: los 915 rechazos caen todos en "neto 0" porque esos contadores
--     sólo se acumulan en los completados. El comportamiento se calcula
--     sumando los movimientos reales ANTERIORES a cada solicitud (punto en el
--     tiempo). Se guardan igual, marcados como no confiables.
--  3. `withdrawals.walletType`/`deposits.walletType` no es el método de pago
--     (todo 'BALANCE'). El método se infiere de coin+network (FIAT USD vs USDT
--     por red) y del procesador.
--  4. Vocabulario real de estados: retiros COMPLETED/REJECTED/CANCELLED/
--     CANCELED(sic, 6 casos)/ON_HOLD/REQUESTED/IN_PROCESS; depósitos
--     COMPLETED/CANCELLED/REQUESTED/IN_REVIEW. CANCELLED lo cancela el
--     cliente: NO es decisión nuestra y NO entrena el score.
--
-- Todo lo del CRM es solo-lectura para nosotros: estas tablas se reescriben
-- desde el sync y jamás se editan a mano. Las decisiones del equipo viven
-- aparte, en withdrawal_reviews, para que un re-sync no las pise.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Espejo: retiros ──────────────────────────────────────────────────────────
create table if not exists public.crm_withdrawals (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  external_id       text not null,                 -- withdrawId del CRM
  user_external_id  text,                          -- userId del CRM
  username          text,
  email             text,
  requested_amount  numeric,
  transaction_amount numeric,
  fee               numeric,
  coin              text,
  network           text,
  processor         text,
  status_raw        text,                          -- tal cual el CRM
  -- Normalizado para el score y los filtros. 'approved' = COMPLETED,
  -- 'rejected' = REJECTED, 'cancelled' = CANCELLED/CANCELED (del cliente),
  -- 'pending' = ON_HOLD/REQUESTED/IN_PROCESS.
  status_norm       text not null check (status_norm in ('approved','rejected','cancelled','pending','unknown')),
  type              text,
  requested_at      timestamptz,
  authorized_at     timestamptz,
  processed_at      timestamptz,
  -- Señal de fraude: la MISMA dirección de destino usada por varios usuarios.
  target_address    text,
  -- Contadores denormalizados del CRM. NO CONFIABLES para el score (ver punto
  -- 2 de la cabecera): se guardan para comparar contra el cálculo real.
  crm_total_deposit_lifetime  numeric,
  crm_total_withdraw_lifetime numeric,
  raw               jsonb,
  synced_at         timestamptz not null default now(),
  constraint crm_withdrawals_unique unique (company_id, external_id)
);
create index if not exists idx_crm_withdrawals_pending
  on public.crm_withdrawals (company_id, requested_at desc)
  where status_norm = 'pending';
create index if not exists idx_crm_withdrawals_user
  on public.crm_withdrawals (company_id, user_external_id, requested_at);
create index if not exists idx_crm_withdrawals_address
  on public.crm_withdrawals (company_id, target_address)
  where target_address is not null;

-- ── Espejo: depósitos ────────────────────────────────────────────────────────
create table if not exists public.crm_deposits (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  external_id       text not null,                 -- depositId
  user_external_id  text,
  -- EL dinero real (ver punto 1 de la cabecera).
  amount_paid       numeric,
  -- Intención del usuario. CORRUPTA en parte del histórico: nunca sumar.
  deposit_value     numeric,
  coin              text,
  network           text,
  -- Id en la pasarela: la llave para conciliar contra api_transactions.
  external_payment_id text,
  is_fiat           boolean,
  status_raw        text,
  status_norm       text not null check (status_norm in ('completed','cancelled','pending','in_review','unknown')),
  type              text,
  deposit_at        timestamptz,
  raw               jsonb,
  synced_at         timestamptz not null default now(),
  constraint crm_deposits_unique unique (company_id, external_id)
);
create index if not exists idx_crm_deposits_user
  on public.crm_deposits (company_id, user_external_id, deposit_at);
create index if not exists idx_crm_deposits_completed
  on public.crm_deposits (company_id, deposit_at desc)
  where status_norm = 'completed';

-- ── Espejo: perfil del cliente ───────────────────────────────────────────────
create table if not exists public.crm_user_snapshots (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  user_external_id  text not null,
  username          text,
  email             text,
  country           text,
  status            text,
  kyc_status        text,
  user_type         text,
  register_date     timestamptz,
  sponsor_username  text,
  rank              text,
  pending_fee_debt  numeric,
  raw               jsonb,
  synced_at         timestamptz not null default now(),
  constraint crm_user_snapshots_unique unique (company_id, user_external_id)
);

-- ── Nuestro estado: la revisión ──────────────────────────────────────────────
-- Vive aparte del espejo para que el sync nunca pise una decisión del equipo.
create table if not exists public.withdrawal_reviews (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  withdrawal_external_id text not null,
  -- Recomendación del sistema en el momento de revisar (se congela: si el
  -- modelo cambia, la decisión pasada conserva el score que se vio).
  score             numeric,
  score_band        text check (score_band in ('low','medium','high')),
  factors           jsonb,                         -- [{code, label, impact, detail}]
  -- Decisión humana. El score NUNCA decide solo.
  decision          text check (decision in ('approve','reject','escalate','pending')),
  decided_by        uuid references auth.users(id),
  decided_by_name   text,
  decided_at        timestamptz,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint withdrawal_reviews_unique unique (company_id, withdrawal_external_id)
);
create index if not exists idx_withdrawal_reviews_company
  on public.withdrawal_reviews (company_id, decided_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Lectura: miembros de la empresa (el módulo se gatea aparte por 'risk').
-- Escritura: sólo service role (el sync y las rutas API con su propio guard).
alter table public.crm_withdrawals     enable row level security;
alter table public.crm_deposits        enable row level security;
alter table public.crm_user_snapshots  enable row level security;
alter table public.withdrawal_reviews  enable row level security;

drop policy if exists crm_withdrawals_select on public.crm_withdrawals;
create policy crm_withdrawals_select on public.crm_withdrawals
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists crm_deposits_select on public.crm_deposits;
create policy crm_deposits_select on public.crm_deposits
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists crm_user_snapshots_select on public.crm_user_snapshots;
create policy crm_user_snapshots_select on public.crm_user_snapshots
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists withdrawal_reviews_select on public.withdrawal_reviews;
create policy withdrawal_reviews_select on public.withdrawal_reviews
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

comment on table public.crm_withdrawals is
  'Espejo de los retiros del CRM (Orion Mongo). Solo lectura: lo reescribe el sync. Las decisiones del equipo van en withdrawal_reviews.';
comment on column public.crm_deposits.deposit_value is
  'Intención del usuario, CORRUPTA en parte del histórico (máx 1,4e16). Nunca sumar: el dinero real es amount_paid.';
comment on column public.crm_withdrawals.crm_total_deposit_lifetime is
  'Contador denormalizado del CRM. NO CONFIABLE para el score: sólo se acumula en los completados (los 915 rechazos dan 0). El comportamiento se calcula punto-en-el-tiempo desde crm_deposits/crm_withdrawals.';
