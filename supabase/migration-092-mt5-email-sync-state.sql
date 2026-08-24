-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 092 — Estado de espejado por correo (MT5)
--
-- POR QUÉ HACE FALTA UNA TABLA SÓLO PARA ESTO
-- El espejo pasa a cubrir el universo completo del CRM (8.709 clientes), y no
-- entra en una corrida: se hace por tandas rotando por antigüedad. Para rotar
-- hay que saber a quién se miró y cuándo.
--
-- El problema: un cliente SIN cuenta en MT5 no genera ninguna fila en
-- `mt5_account_activity`. Si la rotación se ordenara por esa tabla, esos
-- correos serían para siempre "nunca mirados", quedarían eternamente al frente
-- de la cola y **bloquearían la rotación**: cada corrida volvería a
-- preguntarle al broker por los mismos que no existen, y el resto del universo
-- no se espejaría jamás.
--
-- De los 1.787 correos de la primera prueba, 109 no tenían cuenta. Extrapolado
-- al universo completo son cientos de correos girando en falso.
--
-- Por eso acá se registra el INTENTO, no el resultado: "miramos este correo tal
-- día y encontramos N cuentas". Cero es una respuesta válida y se guarda como
-- tal. Es la misma distinción que hace la ficha del retiro entre "no opera" y
-- "no lo sabemos": mezclarlas es lo que rompe.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.mt5_email_sync_state (
  company_id       uuid not null references public.companies(id) on delete cascade,
  -- Correo normalizado, igual que en mt5_account_activity.
  email            text not null,
  last_attempt_at  timestamptz not null default now(),
  -- Cuántas cuentas se encontraron. 0 es un dato, no un fallo.
  accounts_found   integer not null default 0,
  primary key (company_id, email)
);

-- La consulta de la rotación: "los que hace más tiempo que no miro".
create index if not exists idx_mt5_email_state_stale
  on public.mt5_email_sync_state (company_id, last_attempt_at asc);

alter table public.mt5_email_sync_state enable row level security;

drop policy if exists mt5_email_sync_state_select on public.mt5_email_sync_state;
create policy mt5_email_sync_state_select on public.mt5_email_sync_state
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

comment on table public.mt5_email_sync_state is
  'A quien se miro en MT5 y cuando. Registra el INTENTO, no el resultado: un correo sin cuentas guarda accounts_found=0 en vez de no dejar rastro, que es lo que bloquearia la rotacion por tandas.';
