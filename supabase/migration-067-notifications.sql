-- Migración 067 — Bandeja de notificaciones
--
-- El sistema ya sabía cosas importantes y no las contaba: los crons devolvían
-- 200 aunque fallaran por dentro, el guard del libro solo avisaba por Sentry y
-- las órdenes esperando aprobación dependían de que alguien mirara la pantalla.
-- Esta tabla es el canal que faltaba.
--
-- DECISIONES QUE NO SON OBVIAS
--
-- 1. `user_id` apunta a auth.users, NO a company_users. Es el único id que
--    comparten los usuarios de empresa y los superadmin de plataforma: un
--    superadmin no tiene fila en company_users, así que atarlo ahí lo dejaría
--    sin bandeja (el mismo agujero que tenían los emails de reportes).
--    Por eso `company_id` también es nullable.
--
-- 2. El TEXTO no se guarda. Se guardan `type` + `params` y la UI arma la
--    frase con i18n. Guardarla ya renderizada la congelaría en el idioma que
--    el usuario tenía al generarse, y el idioma se cambia con un botón.
--
-- 3. `dedupe_key` + índice único parcial: la sincronización externa corre 4
--    veces al día. Sin esto, un proveedor caído genera 4 avisos diarios
--    idénticos y la campanita se vuelve ruido el primer día. La clave incluye
--    el día, así que un fallo que persiste vuelve a avisar mañana — pero una
--    sola vez.
--    OJO: es un índice PARCIAL, así que NUNCA se puede usar con el upsert de
--    supabase-js (42P10, la lección de la migración 063). Se inserta con
--    ON CONFLICT DO NOTHING desde SQL o se ignora el error 23505.
--
-- 4. RLS: cada uno ve SOLO lo suyo. El `(select auth.uid())` no es cosmético
--    — sin el subselect, Postgres re-evalúa la función por fila (patrón
--    InitPlan de la migración 045).

create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid references public.companies(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  type         text not null,
  severity     text not null default 'normal'
                 check (severity in ('critical', 'high', 'normal')),
  params       jsonb not null default '{}'::jsonb,
  link         text,
  dedupe_key   text,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

-- Bandeja: no leídas primero, más recientes arriba.
create index if not exists notifications_user_idx
  on public.notifications (user_id, read_at, created_at desc);

-- Un aviso pendiente por clave: mientras no se lea, no se repite.
create unique index if not exists notifications_dedupe_idx
  on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null and read_at is null;

alter table public.notifications enable row level security;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select using (user_id = (select auth.uid()));

-- Marcar como leída es lo único que el usuario cambia de su propia fila.
drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- El alta la hace SIEMPRE el servidor con service role (que saltea RLS):
-- una notificación que el cliente pueda fabricar no sirve como aviso.

comment on table public.notifications is
  'Bandeja por usuario. El texto se arma en la UI desde type+params (i18n); acá no se guardan frases.';

-- Alta en lote. Es una RPC y no un insert de supabase-js porque el dedupe se
-- apoya en un índice PARCIAL: `onConflict` de PostgREST no puede targetearlo
-- (42P10 — la lección de la 063). `on conflict do nothing` sin target sí lo
-- respeta.
--
-- SECURITY INVOKER a propósito: la llama el servidor con service role (que
-- saltea RLS). Desde el cliente moriría en RLS porque no hay policy de INSERT
-- — que es exactamente lo que queremos: una notificación que el navegador
-- pueda fabricar no sirve como aviso.
create or replace function public.push_notifications(p_rows jsonb)
returns integer language plpgsql set search_path = public as $$
declare v_count integer;
begin
  insert into public.notifications (company_id, user_id, type, severity, params, link, dedupe_key)
  select nullif(r->>'company_id','')::uuid,
         (r->>'user_id')::uuid,
         r->>'type',
         coalesce(nullif(r->>'severity',''), 'normal'),
         coalesce(r->'params', '{}'::jsonb),
         nullif(r->>'link',''),
         nullif(r->>'dedupe_key','')
    from jsonb_array_elements(p_rows) as r
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end; $$;
