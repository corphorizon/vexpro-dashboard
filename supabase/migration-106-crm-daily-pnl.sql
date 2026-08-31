-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 106 — El cierre diario de PNL, tal como lo da el CRM
--
-- (106 y no 105: el 105 ya está tomado por `migration-105-paypros-en-depositos`
-- en la rama principal. Este repo ya tuvo colisiones de número.)
--
-- ── QUÉ PROBLEMA RESUELVE ──────────────────────────────────────────────────
-- El panel de Orion muestra todos los días tres números que el dashboard no
-- tenía. Captura del 2026-08-31 (mes en curso):
--
--     Total Records   8.040.861
--     Volume          1.408.428,98
--     Total PNL      -$388.584,65
--
-- Lo que el dashboard llamaba "Broker P&L" era otra cosa: en /resumen-general
-- es la cifra que alguien teclea en Carga de Datos ($671.000,00 ese día), y en
-- /finanzas/reportes venía de un endpoint REST `/v1/broker-pnl` que Vex Pro no
-- tiene configurado, así que caía al generador de datos falsos. Dos números
-- distintos con el mismo nombre, y ninguno era el del CRM.
--
-- La reproducción, agregando `pnl_daily` de Orion sobre todo 2026-08:
--     records   8.046.498    vs  8.040.861    (+5.637)
--     volume    1.409.747,03 vs  1.408.428,98 (+1.318,05)
--     pnl        -387.954,95 vs   -388.584,65 (+629,70)
-- Las tres diferencias van en el mismo sentido: el panel se capturó horas
-- antes y el mes seguía operando.
--
-- ── POR QUÉ UNA TABLA Y NO CONSULTAR ORION CADA VEZ ────────────────────────
-- Porque el dato SE PIERDE. `pnl_daily` cambia hacia atrás: Orion retira
-- documentos de cuentas bloqueadas a `pnl_daily_purged` (11.331 documentos, el
-- último lote el 2026-08-31 a las 01:22). El cierre de un día, una vez que
-- pasó, sólo existe si alguien lo guardó. Y además: una pantalla que consulte
-- el Mongo del bróker por visita es una conexión al bróker por visita.
--
-- ── null ≠ 0 ───────────────────────────────────────────────────────────────
-- Un día SIN FILA es "no lo sabemos". Un día en cero es un cierre plano. El
-- cron no escribe filas en cero para los días que Orion no tiene, y la
-- pantalla dibuja el hueco como hueco. Si un día el cron falla, la ventana de
-- la corrida siguiente lo tapa sola (ver src/lib/crm-sync/daily-pnl-sync.ts).
--
-- ── EL SIGNO ───────────────────────────────────────────────────────────────
-- `pnl_usd` es el PNL DEL CLIENTE, con el mismo signo que el panel de Orion.
-- Negativo = el cliente perdió = el bróker ganó. No se invierte al guardar
-- para que la comparación contra el panel sea directa; la ganancia del bróker
-- se deriva en el código (`brokerPnlFromClients`).
--
-- ── LA UNIDAD ──────────────────────────────────────────────────────────────
-- `pnl_usd` YA está en dólares: las cuentas Cent vienen en centavos en Orion y
-- se dividen por `servergroups.centsFactor` antes de sumar. Sin esa división,
-- agosto da -63.297.145,57 en vez de -387.954,95 — 163 veces el número real.
-- Los lotes y los conteos NO se dividen: son unidades, no dinero (regla G3).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.crm_daily_pnl (
  company_id   uuid not null references public.companies(id) on delete cascade,

  /** El día UTC que cerró. El corte es UTC porque el de Orion lo es. */
  utc_day      date not null,

  /** PNL del cliente en USD, Cent ya convertido. NULL = no se pudo calcular. */
  pnl_usd      numeric(20, 2),

  /** Volumen en lotes. Se suma crudo entre familias: es unidad, no dinero. */
  volume_lots  numeric(20, 2) not null default 0,

  /** Operaciones del día (el "Total Records" del panel). */
  deals_count  bigint not null default 0,

  /** Cuentas con actividad ese día. */
  accounts_count integer not null default 0,

  /** Lo EXCLUIDO del dinero, contado: cuentas sin factor de centavos conocido.
      Meterlas con factor 1 podría inflar su PNL cien veces, así que su dinero
      queda afuera — pero se cuenta, porque una exclusión silenciosa es
      indistinguible de un cruce roto. Sus lotes y deals SÍ están en las
      columnas de arriba. */
  unmatched_accounts integer not null default 0,
  unmatched_deals    bigint  not null default 0,
  unmatched_raw_pnl  numeric(20, 2) not null default 0,

  /** Desglose por familia de cuenta (USD / CENT / PROPFIRM / BOOST) con su
      PNL ya en dólares. El registro único de las familias vive en
      src/lib/mt5-sync/pnl.ts (PNL_CATEGORIES); acá no se repite. */
  detail       jsonb,

  /** Fijo: esta tabla es 100% automática. Mismo criterio que
      crm_monthly_totals — el origen manual vive en otras tablas. */
  source       text not null default 'api' check (source = 'api'),

  computed_at  timestamptz not null default now(),

  primary key (company_id, utc_day)
);

comment on table public.crm_daily_pnl is
  'Cierre diario de PNL tal como lo da el CRM (Orion, coleccion pnl_daily). pnl_usd es el PNL del CLIENTE: negativo = gano el broker. Un dia sin fila es "sin dato", nunca cero.';

comment on column public.crm_daily_pnl.pnl_usd is
  'PNL del cliente en USD. Las cuentas Cent ya vienen divididas por servergroups.centsFactor.';

-- La lectura es siempre (empresa, rango de días) ordenada por día.
create index if not exists crm_daily_pnl_lookup
  on public.crm_daily_pnl (company_id, utc_day desc);

alter table public.crm_daily_pnl enable row level security;

-- Mismo patrón que crm_monthly_totals y el resto de tablas de tenant: lectura
-- para los miembros de la empresa; sin policies de escritura porque escribe el
-- cron con el service role, que saltea RLS.
drop policy if exists crm_daily_pnl_select on public.crm_daily_pnl;
create policy crm_daily_pnl_select on public.crm_daily_pnl
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));
