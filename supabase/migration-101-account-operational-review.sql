-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 101 — Diagnóstico operativo por cuenta de trading
--
-- QUÉ SE PIDIÓ (Stiven, 2026-08-27)
-- En la ficha de un retiro, poder ver CÓMO OPERA cada cuenta del cliente —las
-- de trading (BROKER) y las sociales (SOCIAL)— evaluadas con la mayor cantidad
-- posible de las reglas que ya se le aplican a prop firm, y que una cuenta que
-- incumple muchas levante la mano.
--
-- ── POR QUÉ ES UNA SEÑAL APARTE Y NO ENTRA AL SCORE ────────────────────────
-- El score de /risk/retiros es un modelo calibrado sobre 9.785 retiros
-- resueltos, y ahí el trading se dejó a propósito como CONTEXTO: medido sobre
-- 3.711 retiros decididos, "nunca operó" tuvo CERO rechazos. Meter estas
-- reglas al score sería pisar algo medido con una heurística sin medir.
--
-- Así que esto vive aparte: `risk` es su propia señal, se muestra al lado del
-- score y no lo toca. Cuando haya decisiones acumuladas se podrá MEDIR si
-- predice, y recién ahí discutir integrarlo.
--
-- ── POR QUÉ UNA FILA POR CUENTA Y NO POR RETIRO ────────────────────────────
-- El diagnóstico es de la CUENTA, no del retiro: no cambia porque el cliente
-- pida plata. Un usuario con 3 cuentas y 5 retiros generaría 15 filas idénticas
-- si la clave fuera el retiro. Medido el 2026-08-27: 200 retiros instantáneos
-- son 162 usuarios y 595 cuentas — por cuenta se calcula una sola vez.
--
-- La única regla que SÍ depende del retiro —operar después de solicitarlo— se
-- resuelve al leer, comparando `last_trade_at` contra `requested_at`. Es exacta
-- y no cuesta nada.
--
-- ── EL ALCANCE ES TODA LA VIDA DE LA CUENTA ────────────────────────────────
-- Decisión de Stiven. No hay "ciclo" como en prop firm (donde el pago de un
-- retiro reinicia la cuenta): acá se mira el historial completo. `behavior.ts`
-- ya consulta así y está medido: 60 cuentas en 16,7 s emparejando por
-- PositionID, que NO está en el índice. De ahí el techo y el aviso de abajo.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists mt5_account_review (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,

  -- Identidad de la cuenta. `login` es el de MT5; el resto viene del CRM y se
  -- copia acá para que la ficha no tenga que volver a cruzar.
  login             bigint not null,
  user_external_id  text,
  email             text,
  account_type      text,          -- BROKER | SOCIAL | FUNDING
  group_name        text,

  -- ── Operativa (lo que describe CÓMO opera la cuenta) ──
  positions         integer not null default 0,
  first_trade_at    timestamptz,
  last_trade_at     timestamptz,
  net_result        numeric,       -- resultado neto con swap y comisiones
  avg_duration_sec  integer,
  under_1min        integer not null default 0,
  under_5min        integer not null default 0,
  won               integer not null default 0,
  lost              integer not null default 0,
  lots_total        numeric,
  max_drawdown      numeric,       -- sobre saldo (operaciones cerradas)
  top_symbols       jsonb,         -- [{symbol, positions, profit}]

  -- ── Reglas ──
  -- Mismo contrato que la revisión de prop firm: cada check trae
  -- {id, label, status: pass|fail|unverifiable, detail, offendingTrades}.
  -- `unverifiable` existe a propósito: mostrar como "cumple" una regla que no
  -- se pudo comprobar afirmaría un cumplimiento que nadie verificó.
  checks            jsonb not null default '[]'::jsonb,
  violations        integer not null default 0,
  unverifiable      integer not null default 0,

  -- ok | medio | alto. Derivado de `violations` — ver account-review.ts.
  risk              text not null default 'ok',

  -- ── Trazabilidad del cálculo ──
  computed_at       timestamptz not null default now(),
  -- Si la cuenta supera el techo de posiciones, se analiza una parte y ESTO
  -- lo dice. Un recorte silencioso es indistinguible de "no hay más".
  truncated         boolean not null default false,
  warnings          jsonb not null default '[]'::jsonb,

  unique (company_id, login)
);

create index if not exists mt5_account_review_company_idx
  on mt5_account_review (company_id, risk);
create index if not exists mt5_account_review_user_idx
  on mt5_account_review (company_id, user_external_id);
-- La rotación del cron elige por antigüedad del cálculo.
create index if not exists mt5_account_review_stale_idx
  on mt5_account_review (company_id, computed_at);

comment on table mt5_account_review is
  'Diagnostico operativo por cuenta de trading (BROKER/SOCIAL/FUNDING). Senal APARTE del score de retiros: no lo modifica.';
comment on column mt5_account_review.risk is
  'ok | medio | alto — derivado de violations. NO es el score del retiro.';
comment on column mt5_account_review.last_trade_at is
  'Se usa al LEER para resolver "opero despues de solicitar el retiro" contra requested_at.';
comment on column mt5_account_review.truncated is
  'true = la cuenta supera el techo de posiciones y se analizo una parte.';

-- Escribe el cron con service role (bypassa RLS). Desde el navegador, solo
-- lectura y acotada a la empresa del usuario.
alter table mt5_account_review enable row level security;

drop policy if exists mt5_account_review_select on mt5_account_review;
create policy mt5_account_review_select on mt5_account_review
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));
