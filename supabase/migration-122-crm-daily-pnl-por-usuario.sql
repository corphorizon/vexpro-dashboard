-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 122 — El PNL diario del CRM, ATRIBUIDO A LA PERSONA
--
-- (122 y no otro: el último aplicado es el 121. Verificado con
--  `ls supabase/migration-*.sql | tail -3` antes de escribir este archivo. El
--  número se re-elige AL MERGEAR si otra rama lo tomó — ver §0 de
--  docs/reglas-del-proyecto.md.)
--
-- ── QUÉ PROBLEMA RESUELVE ──────────────────────────────────────────────────
-- Comisiones de RRHH necesita el PnL mensual POR PERSONA: el "PNL Report" del
-- CRM se busca por usuario y suma el PnL de las cuentas de su red. Nuestro
-- espejo `crm_daily_pnl` (migración 106) guarda UN agregado por empresa y día:
-- responde "cuánto perdió el cliente el martes", pero NO responde "cuánto de
-- eso es de la red de Fulano". Para comisiones, un total sin dueño no sirve:
-- no se puede pagar.
--
-- El vínculo cuenta → persona YA existe y no hay que inventarlo: los
-- documentos de `pnl_daily` traen `login`, y `tradingaccounts` —la MISMA
-- colección que el sync ya consulta para el `centsFactor`— trae `userId`. Es
-- un campo más en una proyección que ya se pide, no una consulta nueva a
-- Orion. Nuestro espejo `crm_trading_accounts` tiene las 32.838 cuentas con
-- `user_external_id` poblado al 100%, así que el cruce contra RRHH ya cierra.
--
-- ── EL INVARIANTE (lo que hay que poder verificar en producción) ────────────
-- Para un día D y una empresa:
--
--     sum(pnl_usd) de crm_daily_pnl_users   ==   crm_daily_pnl.pnl_usd
--     (filas de personas + la fila '(sin-dueño)')        (mismo día)
--
-- Se sostiene porque las DOS tablas se escriben en la MISMA corrida, del MISMO
-- barrido de documentos y con las MISMAS exclusiones: una cuenta cuyo login no
-- está en `tradingaccounts` tiene `centsFactor` DESCONOCIDO, y su dinero queda
-- afuera de las dos (en el agregado se cuenta en `unmatched_*`; acá no genera
-- fila). Meterla con factor 1 podría inflar su PNL cien veces — la trampa del
-- centavo de la 106, que sin dividir daba -63.297.145,57 en vez de
-- -387.954,95.
--
-- Dos salvedades del invariante, para que nadie lo lea como falso:
--   · CENTAVOS DE REDONDEO. Cada fila redondea a 2 decimales por su cuenta y
--     el agregado redondea el total UNA vez. La diferencia es de centavos y
--     crece con la cantidad de personas del día, nunca con el dinero.
--   · LOTES Y OPERACIONES NO CUADRAN, Y ESTÁ BIEN. En el agregado los lotes y
--     los deals de las cuentas sin factor SÍ suman (regla G3: son unidades, no
--     dinero). Acá esas cuentas no tienen fila, así que
--     sum(deals_count) == crm_daily_pnl.deals_count - unmatched_deals.
--     El invariante es sobre el DINERO.
--
-- ── LA FILA SENTINELA '(sin-dueño)' ────────────────────────────────────────
-- Una cuenta con factor conocido pero SIN `userId` en Orion tiene dinero real
-- y no tiene a quién atribuírselo. No se inventa un dueño ni se descarta en
-- silencio: su dinero va a la fila `user_external_id = '(sin-dueño)'` del día.
-- Es la aplicación literal de la regla del repo — *una exclusión silenciosa es
-- indistinguible de un cruce roto* (§1.2): si esa fila crece, el cruce se está
-- rompiendo y se ve. El cron lo loguea como warning sólo cuando existe.
--
-- El valor no puede colisionar con un id real: los `userId` de Orion son
-- ObjectIds (24 caracteres hex) y este tiene paréntesis y una eñe. Quien
-- consulte por persona debe EXCLUIRLO explícitamente
-- (`user_external_id <> '(sin-dueño)'`), no filtrarlo por casualidad.
--
-- ── LA TRAMPA DE LA PURGA ──────────────────────────────────────────────────
-- `pnl_daily` CAMBIA HACIA ATRÁS: Orion retira documentos de cuentas
-- bloqueadas a `pnl_daily_purged` (11.331 documentos, el último lote el
-- 2026-08-31 a las 01:22). Esta tabla hereda la ventana que reescribe el sync
-- (hoy+ayer en la corrida rápida, 7 días en la completa, o el rango de
-- `?pnl_from&pnl_to`) y, a diferencia del agregado, NO alcanza con hacer
-- upsert: el conjunto de CLAVES cambia. Un usuario que ayer tenía fila y hoy
-- ya no —porque le purgaron los documentos, o porque la cuenta cambió de
-- dueño— quedaría con datos fantasma para siempre.
-- Por eso el sync BORRA las filas de los días que va a reescribir antes de
-- insertarlas (`src/lib/crm-sync/daily-pnl-sync.ts`), y borra exactamente los
-- días que el agregado reescribe: ni uno más. Un día que Orion ya no tiene
-- NO se toca en ninguna de las dos tablas — hueco ≠ cero, y sobre todo: las
-- dos tablas quedan siempre igual de viejas, que es lo que hace verificable el
-- invariante.
--
-- ── null ≠ 0 ───────────────────────────────────────────────────────────────
-- Un (día, persona) SIN FILA es "esa persona no operó ese día, o no lo
-- sabemos". Nunca se escriben filas en cero para rellenar. Y `pnl_usd` es
-- nullable con el mismo criterio de la 106: NULL = no calculable, 0 = cerró
-- plano.
--
-- ── EL SIGNO Y LA UNIDAD (idénticos a la 106, a propósito) ─────────────────
-- `pnl_usd` es el PNL DEL CLIENTE, con el signo del panel de Orion: negativo =
-- el cliente perdió = el bróker ganó. YA está en dólares (las Cent se dividen
-- por `servergroups.centsFactor` ANTES de sumar, por el mismo camino que el
-- agregado). Los lotes y los conteos no se dividen: son unidades.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.crm_daily_pnl_users (
  company_id       uuid not null references public.companies(id) on delete cascade,

  /** El día UTC que cerró. Mismo corte que crm_daily_pnl: el de Orion es UTC. */
  utc_day          date not null,

  /** `tradingaccounts.userId` de Orion — el mismo valor que
      `crm_trading_accounts.user_external_id`, que es por donde engancha RRHH.
      El literal '(sin-dueño)' es la fila sentinela: dinero real de cuentas sin
      `userId`. Ver la cabecera. */
  user_external_id text not null,

  /** PNL del cliente en USD, Cent ya convertido. NULL = no se pudo calcular
      (no es cero). Mismo criterio, signo y unidad que crm_daily_pnl.pnl_usd. */
  pnl_usd          numeric(20, 2),

  /** Volumen en lotes de las cuentas de esa persona ese día. Unidad, no
      dinero: no se divide por el factor de centavos. */
  volume_lots      numeric(20, 2) not null default 0,

  /** Operaciones del día de esa persona. */
  deals_count      bigint not null default 0,

  /** Cuándo lo calculó el cron. Mismo nombre y mismo valor que el
      `computed_at` de crm_daily_pnl en la misma corrida: se descartó agregar
      un `synced_at` aparte justamente porque llevaría el mismo instante — dos
      columnas que nunca difieren son una sola columna con dos nombres, y este
      repo ya sabe cómo termina eso (§1.1). */
  computed_at      timestamptz not null default now(),

  primary key (company_id, utc_day, user_external_id)
);

comment on table public.crm_daily_pnl_users is
  'PNL diario del CRM atribuido al dueño de la cuenta (tradingaccounts.userId), para las comisiones por persona de RRHH. Se escribe en la MISMA corrida que crm_daily_pnl: para un dia, sum(pnl_usd) de esta tabla == crm_daily_pnl.pnl_usd (salvo centavos de redondeo). La fila (sin-dueno) es el dinero de cuentas sin userId: contado, no silenciado.';

comment on column public.crm_daily_pnl_users.user_external_id is
  'tradingaccounts.userId de Orion (= crm_trading_accounts.user_external_id). El literal (sin-dueno) es la fila sentinela y hay que excluirlo explicitamente al consultar por persona.';

comment on column public.crm_daily_pnl_users.pnl_usd is
  'PNL del cliente en USD, con el signo del panel de Orion. Las cuentas Cent ya vienen divididas por servergroups.centsFactor. NULL = no calculable, nunca cero.';

-- La consulta que motivó la tabla es "el mes de esta persona": empresa +
-- persona + rango de días. La PK (company_id, utc_day, user_external_id) no
-- sirve para eso —el día va antes que la persona—, así que el índice invierte
-- las dos últimas columnas.
create index if not exists crm_daily_pnl_users_por_persona
  on public.crm_daily_pnl_users (company_id, user_external_id, utc_day);

alter table public.crm_daily_pnl_users enable row level security;

-- Mismo patrón que crm_daily_pnl y el resto de las tablas de tenant: lectura
-- para los miembros de la empresa; sin policies de escritura, porque escribe
-- el cron con el service role, que saltea RLS.
drop policy if exists crm_daily_pnl_users_select on public.crm_daily_pnl_users;
create policy crm_daily_pnl_users_select on public.crm_daily_pnl_users
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));
