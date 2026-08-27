-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 100 — Totales mensuales que salen SOLOS del CRM
--
-- ── QUÉ PROBLEMA RESUELVE ──────────────────────────────────────────────────
-- Tres números que hoy alguien teclea todos los meses en "Carga de Datos" ya
-- están, al centavo, en el Mongo de Orion:
--
--   · transferencias P2P del mes      → wallettransfers + transferp2ps
--   · ventas de prop firm del mes     → userpropfirms.amountPaid
--   · retiros de prop firm aprobados  → withdrawalpropfirms (status APPROVED)
--
-- La prueba de que es el MISMO número, medida el 2026-08-27 en producción:
--   · p2p_transfers de Vex Pro tiene UN período cargado, 2025-11 = $9.787,04.
--     El total del mes calculado desde Orion (patas OUT de transferencias
--     COMPLETED, netAmount) da $9.787,04. Exacto.
--   · prop_firm_sales de Vex Pro contra userpropfirms.amountPaid por mes:
--     2026-01 16.778 = 16.778 · 2026-02 51.409,65 = 51.409,65 ·
--     2026-03 16.091 ≈ 16.091,10 · 2026-04 10.705,15 = 10.705,15 ·
--     2026-05 10.273 = 10.273 · 2026-06 13.830,20 = 13.830,20.
--
-- ── POR QUÉ UNA TABLA NUEVA Y NO UNA FILA MÁS EN p2p_transfers ─────────────
-- Se intentó y NO se puede: `p2p_transfers` lleva el trigger
-- `trg_guard_closed_period` (migración 066) y Vex Pro tiene NUEVE períodos
-- cerrados (2025-10 → 2026-06). Un cron que escribiera ahí reventaría con
-- check_violation en cada corrida, en todos los meses cerrados — que son
-- justamente los que hay que poder recalcular. Y el UNIQUE
-- (company_id, period_id) de la migración 044 sólo admite UNA fila por
-- período: meter la automática al lado de la manual obliga a tocar ese
-- UNIQUE, el onConflict del upsert manual y todos los lectores.
--
-- Así que lo automático vive acá, con clave (empresa, año, mes, métrica), sin
-- period_id y sin guard. La pantalla muestra las dos columnas al lado y su
-- diferencia. LO MANUAL NO SE PISA NUNCA: este cron no escribe una sola fila
-- en p2p_transfers ni en prop_firm_sales.
--
-- ── LA TRAMPA DEL `max(source)` ────────────────────────────────────────────
-- En el libro de canales, distinguir automático de manual se hizo con una
-- columna `source`, y agregarla con `max(source)` mordió: 'manual' > 'api'
-- alfabéticamente, así que cualquier día con UNA línea manual se veía entero
-- como manual. Acá NO hay nada que agregar: la tabla es 100% automática por
-- construcción (`source` fijo en 'api', comprobado por CHECK) y el origen
-- manual vive en OTRA tabla. Si algún día conviven, el desempate se escribe
-- explícito — nunca con un max() sobre un texto.
--
-- ── null ≠ 0 ───────────────────────────────────────────────────────────────
-- `amount` es NULL cuando el mes no se pudo calcular; 0 cuando se calculó y
-- dio cero. AP Markets no tiene prop firm (0 documentos en userpropfirms y en
-- withdrawalpropfirms el 2026-08-27): sus meses de esas dos métricas quedan
-- SIN FILA, que es "no aplica", y no una fila en 0 que diría "vendimos nada".
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.crm_monthly_totals (
  company_id   uuid not null references public.companies(id) on delete cascade,

  year         integer not null check (year between 2000 and 2100),
  month        integer not null check (month between 1 and 12),

  /** Clave de la métrica. El registro canónico vive en
      src/lib/crm-sync/monthly-totals.ts (CRM_MONTHLY_METRICS); acá no se
      repite la lista para no tener dos que se desincronicen. */
  metric       text not null,

  /** El total del mes. NULL = no se pudo calcular (≠ 0). */
  amount       numeric(20, 2),

  /** El dinero SIEMPRE con su unidad. Orion es 100% USD (verificado). */
  currency     text not null default 'USD',

  /** Cuántos hechos entraron en `amount`. */
  tx_count     integer not null default 0,

  /** Lo EXCLUIDO, contado y con monto: una exclusión silenciosa es
      indistinguible de un cruce roto. */
  excluded_count  integer not null default 0,
  excluded_amount numeric(20, 2) not null default 0,

  /** Por qué se excluyó y contra qué se contrastó. Es lo que hace auditable
      el número sin volver a Mongo. */
  detail       jsonb,

  /** Fijo: esta tabla es el lado automático. Ver la cabecera. */
  source       text not null default 'api' check (source = 'api'),

  computed_at  timestamptz not null default now(),

  primary key (company_id, year, month, metric)
);

comment on table public.crm_monthly_totals is
  'Totales mensuales calculados desde el CRM (Orion). 100% automático: nunca pisa lo cargado a mano, que vive en p2p_transfers / prop_firm_sales / withdrawals.';

-- La lectura es siempre (empresa, métrica) ordenada por mes.
create index if not exists crm_monthly_totals_lookup
  on public.crm_monthly_totals (company_id, metric, year, month);

alter table public.crm_monthly_totals enable row level security;

-- Mismo patrón que el resto de tablas de tenant: lectura para los miembros de
-- la empresa; sin policies de escritura porque escribe el cron con el service
-- role, que saltea RLS.
drop policy if exists crm_monthly_totals_select on public.crm_monthly_totals;
create policy crm_monthly_totals_select on public.crm_monthly_totals
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

-- ─────────────────────────────────────────────────────────────────────────────
-- Y del otro lado: declarar que lo que hay en p2p_transfers es MANUAL.
--
-- La tabla no tenía columna de origen, así que hasta hoy "lo cargó una
-- persona" era una suposición, no un dato. Todas las filas existentes son
-- manuales (el único escritor es el case 'p2p_transfers' de
-- /api/admin/data, que sale del formulario de Carga de Datos), y el DEFAULT
-- deja escrito eso mismo para las que vengan.
--
-- El CHECK admite 'api' aunque hoy nadie lo escriba: si algún día se decide
-- que el cron cargue el período, la columna ya está y el que lo haga tiene
-- que elegir explícitamente el origen en vez de quedar indistinguible.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.p2p_transfers
  add column if not exists source text not null default 'manual';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'p2p_transfers_source_check'
  ) then
    alter table public.p2p_transfers
      add constraint p2p_transfers_source_check check (source in ('manual', 'api'));
  end if;
end $$;

comment on column public.p2p_transfers.source is
  'Quién escribió la fila. Hoy siempre manual (formulario de Carga de Datos). El total automático del CRM vive en crm_monthly_totals y NO se suma a este: son el mismo dinero.';
