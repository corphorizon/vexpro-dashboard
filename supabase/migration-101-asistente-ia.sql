-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 101 (renumerada: la 100 la tomó crm_monthly_totals en un merge paralelo) — Asistente de IA (chat privado por usuario) + credencial
-- `anthropic` por empresa.
--
-- QUÉ PIDIÓ KEVIN (2026-08-27, textual)
-- «una herramienta DE IA POTENCIADA POR ANTHROPIC para admins DE BROKERS, que
-- funcione como un chat privado de cada admin o socio, donde pueda hacer
-- preguntas específicas de un cliente o generales de todo el broker, cosas del
-- módulo de recursos humanos, de finanzas, de riesgo de trading, etc».
--
-- ── POR QUÉ EL CHAT ES PRIVADO A NIVEL RLS Y NO SÓLO EN LA PANTALLA ────────
-- Una conversación de este asistente arrastra, textual, lo que la persona
-- preguntó: nombres de clientes, montos, sospechas sobre un retiro, dudas
-- sobre un empleado. Es material que el que pregunta escribe suponiendo que
-- nadie más lo lee. Si la privacidad viviera sólo en el `where` de la
-- pantalla, el día que alguien agregue un panel de "todas las conversaciones"
-- la suposición se rompe sin que nadie lo note. Por eso las policies exigen
-- `user_id = auth.uid()` ADEMÁS de la empresa: ni el admin de la empresa ni el
-- superadmin leen el chat de otro con la sesión del navegador. El servidor usa
-- service_role (que salta RLS) y filtra a mano por las dos columnas, igual que
-- el resto del repo.
--
-- ── `user_id` VA A auth.users, NO A platform_users ─────────────────────────
-- Regla ya aprendida en este repo (notificaciones, migración 067): las FK de
-- autoría que apunten a `platform_users` dejan afuera al superadmin, que NO
-- tiene fila ahí. `auth.uid()` devuelve el id de auth.users, así que la
-- comparación de la policy sólo cierra si la columna guarda ese mismo id.
--
-- ── POR QUÉ `content` ES TEXT Y `tool_calls` ES JSONB APARTE ───────────────
-- El texto que se le muestra a la persona y el rastro de qué herramientas se
-- consultaron son dos cosas con vidas distintas: el primero se re-renderiza
-- siempre, el segundo es auditoría ("¿de dónde sacó ese número?"). Meterlos en
-- un solo jsonb obligaría a parsear para pintar la burbuja. `usage` se guarda
-- por mensaje porque es lo ÚNICO que permite atribuir el consumo de la API a
-- una empresa cuando cada bróker paga su propia clave (ver abajo).
--
-- ── LA CLAVE DE ANTHROPIC ES POR EMPRESA ──────────────────────────────────
-- Decisión de Kevin (2026-08-27): en un white-label, una sola clave en env
-- significa que el consumo de todos los brókers cae en la misma factura sin
-- poder atribuirse. Se agrega `anthropic` al CHECK de `api_credentials.provider`
-- —mismo camino cifrado que coinsbuy/orion_mongo— y el código cae a
-- `process.env.ANTHROPIC_API_KEY` sólo cuando la empresa no cargó la suya.
-- Ese fallback es aceptable acá y NO lo es en coinsbuy porque no hay riesgo de
-- fuga cruzada: la clave no identifica a ningún tenant del lado de Anthropic,
-- sólo paga. Los datos siguen viniendo del `company_id` del token.
--
-- ── SIN POLICIES DE ESCRITURA PARA EL CLIENTE ─────────────────────────────
-- Los mensajes los escribe SIEMPRE la ruta /api/assistant/chat con el admin
-- client. Un insert desde el navegador podría fabricar un turno de assistant
-- con cualquier contenido y quedaría guardado como si lo hubiera dicho el
-- modelo. Se permite sólo el DELETE del dueño (borrar mi propia conversación)
-- y ninguna otra escritura.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── Credencial `anthropic` por tenant ────────────────────────────────────
-- El CHECK se reemplaza entero porque Postgres no tiene "agregar valor" para
-- un check de lista. Idempotente: drop if exists + add.
alter table public.api_credentials
  drop constraint if exists api_credentials_provider_check;

alter table public.api_credentials
  add constraint api_credentials_provider_check check (
    provider = any (array[
      'sendgrid', 'coinsbuy', 'unipayment', 'fairpay', 'fairpay_banking',
      'orion_crm', 'paypros', 'mt5_sql', 'orion_mongo',
      -- Migración 100: la clave de la API de Anthropic que paga ESTE bróker.
      'anthropic'
    ])
  );

-- ── Conversaciones ───────────────────────────────────────────────────────
create table if not exists public.ai_chats (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  -- auth.users, NO platform_users. Ver cabecera.
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- Título corto para la lista lateral. Lo deriva el servidor del primer
  -- mensaje: pedirle uno al modelo sería una llamada extra por chat.
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- El único acceso real es "mis chats, los más recientes primero". El índice
-- lleva las tres columnas en ese orden para que la lista salga del índice.
create index if not exists ai_chats_owner_idx
  on public.ai_chats (company_id, user_id, updated_at desc);

-- ── Mensajes ─────────────────────────────────────────────────────────────
create table if not exists public.ai_chat_messages (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references public.ai_chats(id) on delete cascade,
  -- Se DUPLICAN company_id/user_id que ya están en ai_chats a propósito: sin
  -- ellos la policy de mensajes necesitaría un subselect a ai_chats en cada
  -- fila, y el servidor no podría hacer su `.eq('company_id', …)` obligatorio
  -- sobre la tabla que consulta. Es el mismo criterio que el resto del repo:
  -- con el admin client la RLS no cubre nada, el filtro explícito sí.
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null default '',
  -- Qué herramientas se consultaron para producir este turno, con su input y
  -- un resumen del resultado. Es el "¿de dónde salió ese número?".
  tool_calls jsonb,
  -- input/output/cache tokens del turno. Atribución de consumo por empresa.
  usage      jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_chat_messages_chat_idx
  on public.ai_chat_messages (chat_id, created_at);

-- ── RLS: el dueño y sólo el dueño ────────────────────────────────────────
alter table public.ai_chats enable row level security;
alter table public.ai_chat_messages enable row level security;

drop policy if exists ai_chats_select_own on public.ai_chats;
create policy ai_chats_select_own on public.ai_chats
  for select using (
    user_id = (select auth.uid())
    and company_id in (select auth_company_ids())
  );

-- Borrar mi propia conversación es la única escritura que el cliente puede
-- hacer. Todo lo demás lo escribe el servidor con service_role.
drop policy if exists ai_chats_delete_own on public.ai_chats;
create policy ai_chats_delete_own on public.ai_chats
  for delete using (
    user_id = (select auth.uid())
    and company_id in (select auth_company_ids())
  );

drop policy if exists ai_chat_messages_select_own on public.ai_chat_messages;
create policy ai_chat_messages_select_own on public.ai_chat_messages
  for select using (
    user_id = (select auth.uid())
    and company_id in (select auth_company_ids())
  );

commit;
