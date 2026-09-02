-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 125 — El espejo del HEDGE FUND del CRM (Orion)
--
-- (125 y no otro: el último archivo del repo es el 124. Verificado con
--  `ls supabase/migration-*.sql | tail -3` antes de escribir esto. El número
--  se RE-ELIGE AL MERGEAR si otra rama lo tomó — §0 de
--  docs/reglas-del-proyecto.md. Ya chocó tres veces.)
--
-- ── QUÉ PROBLEMA RESUELVE ──────────────────────────────────────────────────
-- Los brokers del grupo (Vex Pro y AP Markets) venden un producto de inversión
-- —el hedge fund— que HOY no se ve en ningún lado del dashboard. El CRM tiene
-- nueve colecciones `hedgefund*` con el programa, la inversión de cada cliente,
-- su libro de movimientos, las corridas de pago de rendimiento, las comisiones
-- de red y los certificados; el dashboard no tiene ni una fila de nada de eso.
--
-- Lo único que rozaba el tema eran los movimientos de billetera ya espejados
-- (`crm_wallet_sources`, métrica `hedge_fund`: HEDGE_FUND_INVEST OUT,
-- HEDGE_FUND_REWARD IN/OUT, HEDGE_FUND_RETURN IN — ver crm-wallet-concepts.ts).
-- Esas filas dicen que la plata SE MOVIÓ; no dicen cuánto capital hay bajo
-- gestión, cuándo vence, ni cuánto se le debe a cada cliente. Este espejo sí.
--
-- ── EL CENSO QUE JUSTIFICA EL TAMAÑO (2026-09-02, las dos empresas) ────────
--   AP Markets:  7 fondos · 22 inversiones · 23 comisiones · 2 ledger ·
--                1 payout · 20 certificados
--   Vex Pro:     5 fondos (los cinco con `enabled=false`) · 1 inversión
--   Vacías hoy en las dos: hedgefundwithdrawalrequests, hedgefundmonthlyreturns
--
-- Son volúmenes de tres cifras. Por eso el sync es COMPLETO y no incremental
-- (ver la cabecera de src/lib/crm-sync/hedge-fund.ts): los cursores ya nos
-- costaron seis retiros fantasma de US$ 9.536,98 en agosto de 2026, y acá no
-- compran absolutamente nada.
--
-- ── UNA SOLA COLUMNA DE RELOJ: `synced_at` ─────────────────────────────────
-- La tentación era `synced_at` (cuándo lo escribimos) + `seen_at` (cuándo lo
-- vimos por última vez en el CRM). Como el sync es COMPLETO, las dos llevarían
-- SIEMPRE el mismo instante — y dos columnas que nunca difieren son una sola
-- columna con dos nombres (la lección de la migración 122). Queda una:
--
--     synced_at = la corrida que vio esta fila EN EL CRM.
--
-- Una fila cuyo `synced_at` quedó atrás del `ran_at` de la última corrida es
-- una fila que YA NO ESTÁ en el CRM. NO se borra —el histórico de un fondo
-- terminado sigue valiendo— y el resultado del sync la CUENTA (`unseen`), que
-- es la regla del repo: una desaparición silenciosa es indistinguible de un
-- cruce roto (§1.2).
--
-- ── null ≠ 0 ───────────────────────────────────────────────────────────────
-- Todos los importes y porcentajes son NULLABLE a propósito. `hedgefundmonthly
-- returns` está VACÍA hoy en las dos empresas: la pantalla tiene que decir
-- «sin datos», no «0%». Y `expected_return_*_pct` es null cuando el texto
-- libre del CRM no se pudo parsear — nunca 0, que se leería como «no rinde».
--
-- ── EL TEXTO LIBRE DEL RETORNO ESPERADO ────────────────────────────────────
-- `hedgefunds.expectedReturn` es un STRING escrito a mano ('22-26%'). Se
-- guarda CRUDO en `expected_return_raw` (es lo que el cliente firmó) y además
-- parseado en dos numéricas, para poder proyectar. Las dos cosas: el crudo es
-- el dato, el parseo es una derivación que puede fallar y que se muestra
-- SIEMPRE rotulada como proyección.
--
-- ── LO QUE NO ESTÁ ACÁ, Y POR QUÉ ──────────────────────────────────────────
--   · `hedgefundquestions` / `hedgefundquestionnaireanswers`: fuera de alcance
--     de esta tanda (Kevin, 2026-09-02). Son el cuestionario de idoneidad, no
--     dinero.
--   · `users.totalAmountByHedge`: DESCARTADO. Está en 0 para TODOS los
--     usuarios de las dos empresas (medido el 2026-09-02). Usarlo daría un
--     capital bajo gestión de cero con cara de dato bueno — el fallo que no da
--     error. El capital sale de `hedgefundinvestments.balance`.
--   · La cadena de distribución: el capital del hedge fund queda POR APARTE
--     (Kevin, 2026-09-02). Ninguna de estas tablas la toca.
--
-- Idempotente: `create table if not exists` + `drop policy if exists`.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Los programas ────────────────────────────────────────────────────────
-- La llave natural es `fundKey` ('growth', 'qa-tst'…) y NO el `_id`: es lo que
-- traen las inversiones, el ledger, los payouts y las comisiones. Cruzar por
-- _id obligaría a una traducción en cada join.
create table if not exists public.crm_hf_funds (
  company_id            uuid not null references public.companies(id) on delete cascade,
  fund_key              text not null,
  name                  text,
  subtitle              text,
  strategy              text,
  min_investment        numeric(20, 2),
  holding_months        integer,
  /** El texto libre tal cual lo escribió el CRM ('22-26%'). Es lo que el
      cliente firmó: no se normaliza ni se pisa. */
  expected_return_raw   text,
  /** Derivadas del texto de arriba. NULL = no se pudo parsear, NUNCA 0. */
  expected_return_min_pct numeric(10, 4),
  expected_return_max_pct numeric(10, 4),
  risk                  text,
  currency              text,
  enabled               boolean,
  status                text,
  approval_mode         text,
  close_date            timestamptz,
  slots_total           integer,
  profits_locked        boolean,
  min_remaining_balance numeric(20, 2),
  source_created_at     timestamptz,
  source_updated_at     timestamptz,
  raw                   jsonb not null default '{}'::jsonb,
  synced_at             timestamptz not null default now(),
  primary key (company_id, fund_key)
);

comment on table public.crm_hf_funds is
  'Espejo de hedgefunds (Orion). Llave natural fundKey. synced_at = la corrida que vio la fila EN EL CRM: si queda atras, el fondo ya no esta en el CRM y el sync lo CUENTA como no visto (nunca lo borra).';
comment on column public.crm_hf_funds.expected_return_raw is
  'Texto libre del CRM (22-26%). Es el dato; las dos columnas _pct son una derivacion que puede ser NULL.';
comment on column public.crm_hf_funds.enabled is
  'Vex Pro tiene sus cinco fondos con enabled=false y aun asi los ofrece (marca Vex Capital). Un fondo deshabilitado SE MUESTRA, con badge.';

-- ── 2. Las inversiones ──────────────────────────────────────────────────────
create table if not exists public.crm_hf_investments (
  company_id        uuid not null references public.companies(id) on delete cascade,
  investment_id     text not null,
  /** '#HF-1021' — la referencia que ve el cliente. */
  ref               text,
  /** `hedgefundinvestments.userId` = crm_user_snapshots.user_external_id. */
  user_external_id  text,
  fund_key          text,
  program           text,
  invested          numeric(20, 2),
  principal         numeric(20, 2),
  balance           numeric(20, 2),
  currency          text,
  holding_months    integer,
  start_date        timestamptz,
  end_date          timestamptz,
  status            text,
  accepted_tc       boolean,
  approved_at       timestamptz,
  approved_by       text,
  rejected_at       timestamptz,
  rejected_by       text,
  rejected_reason   text,
  closed_at         timestamptz,
  closed_reason     text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  raw               jsonb not null default '{}'::jsonb,
  synced_at         timestamptz not null default now(),
  primary key (company_id, investment_id)
);

comment on column public.crm_hf_investments.balance is
  'Saldo VIVO de la inversion (principal + rendimientos acreditados - retiros). El AUM sale de la suma de esta columna en las ACTIVE. NO se usa users.totalAmountByHedge: esta en 0 para todos (medido 2026-09-02).';

create index if not exists crm_hf_investments_por_fondo
  on public.crm_hf_investments (company_id, fund_key);
create index if not exists crm_hf_investments_por_cliente
  on public.crm_hf_investments (company_id, user_external_id);
-- El calendario de vencimientos y la alerta de «vence en 30 dias» entran por
-- acá: empresa + fecha de fin.
create index if not exists crm_hf_investments_por_vencimiento
  on public.crm_hf_investments (company_id, end_date);

-- ── 3. El libro por inversión ───────────────────────────────────────────────
create table if not exists public.crm_hf_ledger_entries (
  company_id        uuid not null references public.companies(id) on delete cascade,
  entry_id          text not null,
  investment_id     text,
  user_external_id  text,
  fund_key          text,
  /** 'PAYOUT' | 'TERMINATION' | … El vocabulario lo pone el CRM y no se
      normaliza: un valor nuevo tiene que VERSE, no caer en 'unknown'. */
  type              text,
  /** Con SIGNO. Un credito de rendimiento es positivo, una terminacion resta. */
  amount            numeric(20, 2),
  balance_before    numeric(20, 2),
  balance_after     numeric(20, 2),
  currency          text,
  /** Nullable de verdad: los asientos que no vienen de una corrida de pago
      (terminaciones, ajustes) no tienen payout. */
  payout_id         text,
  description       text,
  source_created_at timestamptz,
  raw               jsonb not null default '{}'::jsonb,
  synced_at         timestamptz not null default now(),
  primary key (company_id, entry_id)
);

create index if not exists crm_hf_ledger_por_inversion
  on public.crm_hf_ledger_entries (company_id, investment_id);
create index if not exists crm_hf_ledger_por_fondo
  on public.crm_hf_ledger_entries (company_id, fund_key);
create index if not exists crm_hf_ledger_por_cliente
  on public.crm_hf_ledger_entries (company_id, user_external_id);

-- ── 4. Las corridas de pago de rendimiento ──────────────────────────────────
create table if not exists public.crm_hf_payouts (
  company_id        uuid not null references public.companies(id) on delete cascade,
  payout_id         text not null,
  fund_key          text,
  program           text,
  /** El % que se pagó en esa corrida. NULL = no vino, no es 0%. */
  percent           numeric(10, 4),
  status            text,
  accounts_affected integer,
  total_credited    numeric(20, 2),
  currency          text,
  executed_by       text,
  started_at        timestamptz,
  finished_at       timestamptz,
  source_created_at timestamptz,
  raw               jsonb not null default '{}'::jsonb,
  synced_at         timestamptz not null default now(),
  primary key (company_id, payout_id)
);

create index if not exists crm_hf_payouts_por_fondo
  on public.crm_hf_payouts (company_id, fund_key);

-- ── 5. Las comisiones de red ────────────────────────────────────────────────
-- Kevin, 2026-09-02: la config de AP quedó en 0/0/0 A PROPÓSITO (fue un error
-- corregido). Las 23 comisiones que existen son ANTERIORES a esa corrección y
-- por eso siguen valiendo. Ver crm_hf_commission_config_snapshots.
create table if not exists public.crm_hf_commissions (
  company_id                    uuid not null references public.companies(id) on delete cascade,
  commission_id                 text not null,
  /** 'DIRECT' | 'RECURRING'. */
  type                          text,
  beneficiary_user_external_id  text,
  beneficiary_username          text,
  source_user_external_id       text,
  source_username               text,
  investment_id                 text,
  fund_key                      text,
  level                         integer,
  percent                       numeric(10, 4),
  base_amount                   numeric(20, 2),
  /** Con SIGNO: un reverso es negativo y TIENE que poder serlo. Clampear a 0
      escondería una devolución — el mismo error de la regla #1 de comisiones
      (§2.1: una comision negativa ES deuda). */
  amount                        numeric(20, 2),
  currency                      text,
  /** 'YYYY-MM' solo en las RECURRING. NULL en las DIRECT: no es un hueco. */
  ym                            text,
  status                        text,
  paid_at                       timestamptz,
  source_created_at             timestamptz,
  raw                           jsonb not null default '{}'::jsonb,
  synced_at                     timestamptz not null default now(),
  primary key (company_id, commission_id)
);

create index if not exists crm_hf_commissions_por_fondo
  on public.crm_hf_commissions (company_id, fund_key);
create index if not exists crm_hf_commissions_por_beneficiario
  on public.crm_hf_commissions (company_id, beneficiary_user_external_id);
create index if not exists crm_hf_commissions_por_inversion
  on public.crm_hf_commissions (company_id, investment_id);

-- ── 6. El VIGILANTE de la configuración de comisiones ───────────────────────
--
-- `hedgefundcommissionconfigs` es un SINGLETON por empresa: un solo documento
-- con los niveles directos y los recurrentes. En AP Markets está hoy en
-- 0/0/0 y Kevin (2026-09-02) decidió que DEBE QUEDAR ASÍ: fue un error que ya
-- se corrigió. Lo que hay que poder contestar dentro de tres meses es «¿alguien
-- lo volvió a tocar?», y para eso hace falta guardar el histórico.
--
-- Esta tabla NO es un espejo: es un HISTORIAL. Se inserta una fila SÓLO cuando
-- los porcentajes cambian respecto del último snapshot; si son iguales se
-- actualiza `last_seen_at` del último. Así una corrida cada 15 minutos no
-- genera 96 filas por día, y la cantidad de filas es literalmente la cantidad
-- de veces que la configuración cambió.
--
-- `fingerprint` es la comparación: el texto canónico de los niveles ordenados.
-- Comparar el jsonb entero traería `updatedAt` y dispararía una alerta cada vez
-- que alguien abre y guarda la pantalla sin cambiar nada.
create table if not exists public.crm_hf_commission_config_snapshots (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  /** Texto canónico de los niveles. Dos snapshots con el mismo fingerprint
      son la MISMA configuración aunque difieran en updatedAt. */
  fingerprint       text not null,
  direct_levels     jsonb,
  recurring_levels  jsonb,
  max_levels        integer,
  source_updated_at timestamptz,
  updated_by        text,
  raw               jsonb not null default '{}'::jsonb,
  /** Cuándo vimos ESTA configuración por primera vez. */
  first_seen_at     timestamptz not null default now(),
  /** Cuándo la vimos por última vez. Se pisa en cada corrida que la confirme. */
  last_seen_at      timestamptz not null default now()
);

comment on table public.crm_hf_commission_config_snapshots is
  'HISTORIAL (no espejo) de hedgefundcommissionconfigs. Una fila por CAMBIO: si el fingerprint coincide con el ultimo, solo se pisa last_seen_at. Kevin 2026-09-02: AP quedo en 0/0/0 a proposito y hay que vigilar que nadie lo mueva.';

create index if not exists crm_hf_config_snap_por_empresa
  on public.crm_hf_commission_config_snapshots (company_id, first_seen_at desc);

-- ── 7. Solicitudes de retiro del fondo ──────────────────────────────────────
-- VACÍA en las dos empresas al 2026-09-02. Se espeja igual, con las columnas
-- que los ÍNDICES del CRM confirman que existen (requestId, investmentId,
-- userId, status, type) y el resto en `raw`: el día que aparezca la primera
-- solicitud, la pantalla y la alerta ya están, y lo que no tenga columna se
-- puede leer del jsonb sin volver a Orion.
create table if not exists public.crm_hf_withdrawal_requests (
  company_id        uuid not null references public.companies(id) on delete cascade,
  request_id        text not null,
  investment_id     text,
  user_external_id  text,
  fund_key          text,
  status            text,
  type              text,
  amount            numeric(20, 2),
  currency          text,
  requested_at      timestamptz,
  processed_at      timestamptz,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  raw               jsonb not null default '{}'::jsonb,
  synced_at         timestamptz not null default now(),
  primary key (company_id, request_id)
);

create index if not exists crm_hf_withdrawal_requests_por_estado
  on public.crm_hf_withdrawal_requests (company_id, status);
create index if not exists crm_hf_withdrawal_requests_por_inversion
  on public.crm_hf_withdrawal_requests (company_id, investment_id);

-- ── 8. Rendimientos mensuales por fondo ─────────────────────────────────────
-- También VACÍA hoy. El único índice del CRM es (fundKey, ym), así que ésa es
-- la llave. `percent` y `amount` son NULLABLE y se llenan sólo si el documento
-- los trae: la pantalla muestra «sin datos» y no «0%». Kevin, 2026-09-02: los
-- primeros rendimientos se pagan este mes (septiembre 2026), así que esta
-- tabla pasa de vacía a poblada en días.
create table if not exists public.crm_hf_monthly_returns (
  company_id  uuid not null references public.companies(id) on delete cascade,
  fund_key    text not null,
  ym          text not null,
  percent     numeric(10, 4),
  amount      numeric(20, 2),
  raw         jsonb not null default '{}'::jsonb,
  synced_at   timestamptz not null default now(),
  primary key (company_id, fund_key, ym)
);

comment on column public.crm_hf_monthly_returns.percent is
  'NULL = el documento no trae el dato. NUNCA 0: sin dato y sin rendimiento son cosas distintas y la pantalla las dibuja distinto.';

-- ── 9. Certificados ─────────────────────────────────────────────────────────
create table if not exists public.crm_hf_certificates (
  company_id        uuid not null references public.companies(id) on delete cascade,
  certificate_id    text not null,
  /** 'HF-CERT-000020' — el número impreso. */
  number            text,
  investment_id     text,
  user_external_id  text,
  investor_name     text,
  investment_date   timestamptz,
  amount            numeric(20, 2),
  currency          text,
  fund_key          text,
  program           text,
  sent_at           timestamptz,
  source_created_at timestamptz,
  raw               jsonb not null default '{}'::jsonb,
  synced_at         timestamptz not null default now(),
  primary key (company_id, certificate_id)
);

create index if not exists crm_hf_certificates_por_inversion
  on public.crm_hf_certificates (company_id, investment_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Mismo patrón que crm_daily_pnl / crm_daily_pnl_users y el resto de las
-- tablas crm_*: SELECT para los miembros de la empresa y NINGUNA policy de
-- escritura, porque escribe el cron con el service role (que saltea RLS).
--
-- Recordatorio de §4.2 que RLS no cubre: con el admin client el
-- `.eq('company_id', …)` explícito en cada query es OBLIGATORIO.

alter table public.crm_hf_funds                       enable row level security;
alter table public.crm_hf_investments                 enable row level security;
alter table public.crm_hf_ledger_entries              enable row level security;
alter table public.crm_hf_payouts                     enable row level security;
alter table public.crm_hf_commissions                 enable row level security;
alter table public.crm_hf_commission_config_snapshots enable row level security;
alter table public.crm_hf_withdrawal_requests         enable row level security;
alter table public.crm_hf_monthly_returns             enable row level security;
alter table public.crm_hf_certificates                enable row level security;

drop policy if exists crm_hf_funds_select on public.crm_hf_funds;
create policy crm_hf_funds_select on public.crm_hf_funds
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists crm_hf_investments_select on public.crm_hf_investments;
create policy crm_hf_investments_select on public.crm_hf_investments
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists crm_hf_ledger_entries_select on public.crm_hf_ledger_entries;
create policy crm_hf_ledger_entries_select on public.crm_hf_ledger_entries
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists crm_hf_payouts_select on public.crm_hf_payouts;
create policy crm_hf_payouts_select on public.crm_hf_payouts
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists crm_hf_commissions_select on public.crm_hf_commissions;
create policy crm_hf_commissions_select on public.crm_hf_commissions
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists crm_hf_config_snapshots_select on public.crm_hf_commission_config_snapshots;
create policy crm_hf_config_snapshots_select on public.crm_hf_commission_config_snapshots
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists crm_hf_withdrawal_requests_select on public.crm_hf_withdrawal_requests;
create policy crm_hf_withdrawal_requests_select on public.crm_hf_withdrawal_requests
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists crm_hf_monthly_returns_select on public.crm_hf_monthly_returns;
create policy crm_hf_monthly_returns_select on public.crm_hf_monthly_returns
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists crm_hf_certificates_select on public.crm_hf_certificates;
create policy crm_hf_certificates_select on public.crm_hf_certificates
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));
