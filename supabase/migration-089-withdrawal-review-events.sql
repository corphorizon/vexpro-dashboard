-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 089 — Historial de decisiones de retiros (append-only)
--
-- POR QUÉ HACE FALTA
-- `withdrawal_reviews` (migración 088) guarda UNA fila por retiro y cada
-- decisión pisa la anterior. Sirve para responder rápido "¿en qué estado está
-- esto?", pero pierde el hecho de que hubo una decisión previa.
--
-- Eso borra justamente la evidencia de que el control funcionó. Con el reparto
-- que definió Kevin —soporte triajea y escala, el auditor aprueba— un caso
-- normal son DOS hechos distintos:
--     soporte escala  →  auditor aprueba
-- y con sólo la última fila, el escalamiento desaparece en cuanto el auditor
-- decide. Lo mismo con un cambio de opinión: si alguien aprueba y media hora
-- después rechaza, hoy no queda rastro de que hubo un ida y vuelta.
--
-- EL DISEÑO
-- La tabla de estado se queda como está (lecturas rápidas, una fila por
-- retiro). Al lado va este registro de eventos donde SÓLO se inserta: un
-- disparador rechaza UPDATE y DELETE, igual que en los cierres de período y
-- las órdenes de pago. Un historial que se puede editar no es un historial.
--
-- Se guarda el ROL del autor en el momento del hecho, no sólo su nombre: los
-- roles cambian, y dentro de un año hay que poder demostrar que quien aprobó
-- tenía permiso para aprobar ESE día.
--
-- El score se congela por evento. El modelo se recalibra; la decisión pasada
-- tiene que conservar el número que la persona vio en pantalla.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.withdrawal_review_events (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  withdrawal_external_id text not null,

  decision          text not null check (decision in ('approve','reject','escalate','pending')),
  notes             text,

  -- Foto del score EN EL MOMENTO del hecho (ver cabecera).
  score             numeric,
  score_band        text check (score_band in ('low','medium','high')),
  calibration_id    text,
  factors           jsonb,

  -- Quién, y con qué rol lo hizo ENTONCES.
  actor_id          uuid references auth.users(id),
  actor_name        text,
  actor_role        text,

  created_at        timestamptz not null default now()
);

-- La consulta natural es "dame la historia de este retiro, del más nuevo al
-- más viejo".
create index if not exists idx_wd_review_events_withdrawal
  on public.withdrawal_review_events (company_id, withdrawal_external_id, created_at desc);

-- Y la de auditoría: "qué decidió esta persona / qué pasó en estas fechas".
create index if not exists idx_wd_review_events_actor
  on public.withdrawal_review_events (company_id, created_at desc);

-- ── Inmutabilidad ────────────────────────────────────────────────────────────
-- Sin esto la tabla es sólo una convención, y las convenciones se rompen con
-- un UPDATE apurado un viernes. El disparador la vuelve append-only de verdad,
-- incluso para el service role.
create or replace function public.withdrawal_review_events_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'withdrawal_review_events es un historial inmutable: sólo admite INSERT (intento de % denegado)',
    tg_op
    using errcode = '42501';
end;
$$;

drop trigger if exists trg_wd_review_events_no_update on public.withdrawal_review_events;
create trigger trg_wd_review_events_no_update
  before update or delete on public.withdrawal_review_events
  for each row execute function public.withdrawal_review_events_immutable();

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Mismo criterio que las tablas de la 088: leen los miembros de la empresa (el
-- módulo 'risk' y el rol se gatean en la API), escribe sólo el service role.
alter table public.withdrawal_review_events enable row level security;

drop policy if exists withdrawal_review_events_select on public.withdrawal_review_events;
create policy withdrawal_review_events_select on public.withdrawal_review_events
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

comment on table public.withdrawal_review_events is
  'Historial APPEND-ONLY de decisiones sobre retiros. Un disparador rechaza UPDATE y DELETE. withdrawal_reviews guarda el estado actual; esta tabla guarda cómo se llegó a él.';
comment on column public.withdrawal_review_events.actor_role is
  'Rol del autor EN EL MOMENTO del hecho. Los roles cambian: hay que poder demostrar que quien aprobó podía aprobar ese día.';
comment on column public.withdrawal_review_events.score is
  'Score congelado al decidir. El modelo se recalibra; la decisión pasada conserva el número que se vio en pantalla.';
