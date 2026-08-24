-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 091 — Tokens de la API para aplicativos (Atlas y compañía)
--
-- POR QUÉ EXISTE
-- Smart Dashboard es el ÚNICO que se conecta al MySQL de MT5 del broker. Los
-- demás aplicativos (Atlas, el Asistente, el sistema de tareas) leen por una
-- API nuestra. Esto guarda las llaves de esos aplicativos.
--
-- Tres razones para que sea así y no que cada uno se conecte solo:
--   · el hosting del broker filtra por IP — una puerta, una IP que autorizar;
--   · una consulta mal escrita contra una tabla de 68 millones de filas afecta
--     la operación real del broker (medida: 31 segundos);
--   · rotar una contraseña con N copias repartidas es cómo se filtran.
--
-- ── EL TOKEN NO SE GUARDA ──────────────────────────────────────────────────
-- Sólo su SHA-256. Si esta tabla se filtra, no sirve para llamar a la API. El
-- token en claro se muestra UNA vez, al crearlo, y si se pierde se rota.
-- `token_prefix` guarda los primeros caracteres para poder decir "el token de
-- Atlas que termina en…" sin tener el secreto.
--
-- ── ALCANCE ────────────────────────────────────────────────────────────────
-- Cada token está atado a UNA empresa y a una lista de permisos. Un token de
-- Atlas para Vex Pro no puede leer datos de otra organización: el company_id
-- sale del token, NUNCA de un parámetro que mande quien llama.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.partner_api_tokens (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,

  -- Nombre del aplicativo consumidor: 'atlas', 'assistant', 'task-system'…
  app_name       text not null,
  -- Para identificar el token sin conocerlo.
  token_prefix   text not null,
  -- SHA-256 en hex del token completo. Nunca el token.
  token_hash     text not null,

  -- Permisos. Hoy: 'mt5:read'. Un token sin permisos no puede hacer nada, que
  -- es el default correcto.
  scopes         text[] not null default '{}',

  is_active      boolean not null default true,
  revoked_at     timestamptz,
  revoked_reason text,

  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id),
  created_by_name text,

  -- Para poder contestar "¿esto todavía se usa?" antes de revocar algo vivo.
  last_used_at   timestamptz,
  last_used_ip   text,
  request_count  bigint not null default 0,

  constraint partner_api_tokens_hash_unique unique (token_hash)
);

create index if not exists idx_partner_tokens_company
  on public.partner_api_tokens (company_id, app_name);

create index if not exists idx_partner_tokens_active
  on public.partner_api_tokens (token_hash) where is_active;

-- ── RLS: nadie desde el cliente ──────────────────────────────────────────────
-- RLS activa y SIN políticas: ni anon ni authenticated pueden leer ni escribir
-- esta tabla. Sólo el service role, desde rutas con su propio control. Un
-- token de aplicativo no tiene por qué ser visible desde el navegador de nadie.
alter table public.partner_api_tokens enable row level security;

comment on table public.partner_api_tokens is
  'Llaves de los aplicativos que consumen nuestra API (Atlas y compania). Guarda el SHA-256, NUNCA el token. RLS activa sin politicas: solo service role.';
comment on column public.partner_api_tokens.company_id is
  'Alcance del token. El company_id de una peticion sale SIEMPRE de aca, nunca de un parametro de quien llama.';
comment on column public.partner_api_tokens.token_hash is
  'SHA-256 hex del token. Si esta tabla se filtra, no sirve para llamar a la API.';
