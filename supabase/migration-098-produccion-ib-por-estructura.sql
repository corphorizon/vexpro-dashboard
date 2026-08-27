-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 098 — La producción IB (lotes pagados, PNL y comisión) por
-- estructura comercial, con el desglose forex / sintéticos
--
-- QUÉ PIDIÓ KEVIN (2026-08-27, textual)
-- «Me gustaría tener el dato por estructura del PNL de cada BDM, de la cantidad
-- de pagos por lotes y lotes movidos que se pagaron (basado en el crm, ya que
-- tiene ciertas reglas para pagar), discriminar por activos de forex y activos
-- sintéticos».
--
-- ── LAS DOS FUENTES, Y POR QUÉ HAY QUE ESPEJARLAS ──────────────────────────
-- Todo sale del Mongo de Orion. Medido el 2026-08-27:
--
--   `ibrewards`        11.829.132 docs — UNA fila por (operación × nivel de IB).
--                      Trae symbol, lots, commission, pnl, groupName, ibUserId.
--                      COBERTURA: 2026-08-13 03:15 → 2026-08-27 09:44. QUINCE
--                      DÍAS. La colección se purga: lo viejo YA NO ESTÁ.
--
--   `ib_reward_daily`      37.146 docs — el rollup diario de la anterior por IB.
--                      COBERTURA: 2025-10 → 2026-08, once meses completos.
--                      NO tiene símbolo, así que el desglose no puede salir de acá.
--
-- Verificado que la segunda es EXACTAMENTE el rollup de la primera: el día
-- 2026-08-25 da lots 8.395,62864, comisión 4.118,300823871892, pnl
-- 1.942.516,76 y 816.009 premios sobre 240 IB en LAS DOS. Dígito por dígito.
--
--   `commissiontrades`      2.305 docs — cobertura 2026-08-27 08:46 → 09:44.
--                      UNA HORA. No sirve como fuente histórica de nada. Sus
--                      dos "backups" (322.356 y 628.918 docs) NO son trades:
--                      son bitácoras de reprecio (oldAmount/newAmount/runTs) y
--                      no tienen ni símbolo ni fecha de operación.
--
-- ── ESPEJO Y NO CONSULTA AL VUELO — CON LOS NÚMEROS ────────────────────────
-- Para `ib_reward_daily` daría igual: 37.146 docs, ~5.500 por mes, un $group
-- al vuelo cuesta menos de un segundo. Lo que decide son las otras dos cosas:
--
--   1. AGREGAR `ibrewards` AL VUELO ES INVIABLE. Un $group por mes sobre
--      11,8M docs tardó minutos en las pruebas; el techo de una función de
--      Vercel son 300 s y esta pantalla la abre una persona esperando.
--   2. LO QUE NO SE ESPEJA HOY SE PIERDE. `ibrewards` guarda quince días y
--      purga. Sin espejo, el desglose forex/sintéticos NUNCA va a tener más de
--      quince días de historia, por mucho que se espere.
--
-- El espejo del desglose es diminuto: la clase de activo son DOS valores y hubo
-- 240 IB con actividad el día más movido → ~500 filas por día, ~15.000 por mes.
-- Se cambia una agregación de 11,8M docs por una lectura de 15.000 filas.
--
-- ── SIN DATO NO ES CERO ────────────────────────────────────────────────────
-- Los meses anteriores a que este espejo empiece a correr NO tienen desglose y
-- nunca lo van a tener. La API no devuelve cero para ellos: mira qué días de
-- ese mes hay en `crm_ib_reward_symbol_daily` y si no hay ninguno la celda dice
-- "sin dato". Mismo criterio que las columnas nulables de la migración 093.
--
-- ── EL PNL NO SE SUMA HACIA ARRIBA, Y ESTO ES LO MÁS FÁCIL DE ROMPER ───────
-- `pnl` es la ganancia del TRADER en esa operación, y `ibrewards` la repite una
-- vez por cada nivel de IB que cobra por ella. Medido el 2026-08-25: la suma
-- cruda de pnl da 1.942.516,76, pero deduplicando por dealId son 393.366,44
-- sobre 166.512 operaciones — 4,9 niveles por operación de promedio.
--
-- Por eso `pnl` acá es "el PNL de las operaciones por las que ESTE IB cobró", y
-- es una cifra POR IB, no un agregado apilable. El rollup por estructura suma
-- el `own` de cada perfil igual que el net deposit (cada cliente cuelga de un
-- único comercial, así que a nivel de perfil no hay repetición), pero la
-- pantalla lo rotula como PNL atribuido y no como "el PNL de la empresa".
--
-- ── LAS CENT SE PAGAN EN USD CON LOS LOTES ÷100 ────────────────────────────
-- Verificado a escala sobre `commissiontrades` (rawLite.Volume ÷ lots, por
-- grupo, 2.279 filas): los grupos normales dan 10.000 EXACTO en las 1.351 filas
-- (Investor STP VIP, Master STP VIP, STP, Synthetics, STP ELITE, PRO…) y los
-- grupos cent dan 1.000.000 EXACTO en las 928 (CENT, Master Cent, Investor
-- Cent, Cent., CENT Mastertraders…). Cien veces más: el lote cent ya viene
-- convertido a lote estándar en el campo `lots`. No hay que dividir nada acá.
-- La moneda es USD en el 100% de las filas de las dos colecciones (verificado).
--
-- ── VALIDADO CONTRA UNA SEGUNDA FUENTE ANTES DE CONSTRUIR ──────────────────
-- `ib_reward_daily.totalCommission` contra lo que la billetera del CRM acreditó
-- como comisiones IB (`wallettransfers` IN con los conceptos IB_REWARDS_BROKER
-- y sus tres variantes de escritura). Acumulado de toda la historia por IB:
--
--     702 IB con premios · 541 con crédito en billetera
--     488 cuadran dentro del 1%  ·  501 dentro del 5%
--     total calculado 776.946,23 · total acreditado 845.167,32 · −8,07%
--
-- El hueco NO es sistémico: 62.257 de los 68.221 (91%) están en DIEZ IB de 702,
-- y la causa está identificada — el 2026-04-15 la billetera acreditó
-- 51.271,27 de golpe a 141 IB, tres transferencias por cabeza, un pago manual
-- que nunca pasó por el pipeline diario de premios. Sacando abril, las dos
-- fuentes quedan en −2,14%. El resto es el desfase del cron de pago en los
-- bordes de mes (acredita de madrugada lo del día anterior).
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. Espejo del rollup diario por IB ──────────────────────────────────────
-- Es `ib_reward_daily` tal cual, con los nombres del repo. `day` es el día de
-- la OPERACIÓN, no el del pago: el pago se acredita de madrugada al día
-- siguiente y mezclarlos corría un día toda la serie.

create table if not exists public.crm_ib_reward_daily (
  company_id     uuid not null references public.companies(id) on delete cascade,
  day            date not null,
  ib_user_id     text not null,
  -- Lotes ESTÁNDAR. Las cuentas cent ya vienen convertidas en el origen (÷100).
  lots           numeric not null default 0,
  -- Comisión pagada al IB, USD (currency='USD' en el 100% de las filas).
  commission     numeric not null default 0,
  -- PNL del trader en las operaciones por las que este IB cobró. POR IB: no es
  -- apilable entre IB sin repetir (4,9 niveles por operación). Ver cabecera.
  pnl            numeric not null default 0,
  -- "Cantidad de pagos por lotes": una fila de premio por operación y nivel.
  rewards_count  bigint  not null default 0,
  synced_at      timestamptz not null default now(),
  primary key (company_id, day, ib_user_id)
);

create index if not exists idx_crm_ib_reward_daily_dia
  on public.crm_ib_reward_daily (company_id, day);

-- ── 2. Espejo del desglose por clase de activo ──────────────────────────────
-- La clase la decide `classifyAssetClass` (src/lib/crm-sync/asset-class.ts) al
-- momento de espejar y se guarda YA RESUELTA. Es a propósito: si la lista de
-- patrones viviera también acá habría dos registros que se desincronizan en
-- silencio, que es el modo de fallo #1 de este repo.
--
-- El CHECK repite los dos valores porque es la aduana real de la base; la lista
-- de PATRONES, que es lo que de verdad puede cambiar, sigue estando en un solo
-- lugar.

create table if not exists public.crm_ib_reward_symbol_daily (
  company_id     uuid not null references public.companies(id) on delete cascade,
  day            date not null,
  ib_user_id     text not null,
  asset_class    text not null check (asset_class in ('forex', 'synthetic')),
  lots           numeric not null default 0,
  commission     numeric not null default 0,
  rewards_count  bigint  not null default 0,
  synced_at      timestamptz not null default now(),
  primary key (company_id, day, ib_user_id, asset_class)
);

create index if not exists idx_crm_ib_reward_symbol_daily_dia
  on public.crm_ib_reward_symbol_daily (company_id, day);

-- ── 3. RLS, igual que las tablas hr_ y que crm_customer_aggregates ─────────
-- Lectura para quien pertenece a la empresa; escritura sólo por service_role
-- (el cron), que hace bypass de RLS. Sin policy de INSERT/UPDATE a propósito:
-- nadie escribe un espejo desde el navegador.

alter table public.crm_ib_reward_daily enable row level security;
alter table public.crm_ib_reward_symbol_daily enable row level security;

drop policy if exists crm_ib_reward_daily_select on public.crm_ib_reward_daily;
create policy crm_ib_reward_daily_select on public.crm_ib_reward_daily
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

drop policy if exists crm_ib_reward_symbol_daily_select on public.crm_ib_reward_symbol_daily;
create policy crm_ib_reward_symbol_daily_select on public.crm_ib_reward_symbol_daily
  for select to authenticated
  using (company_id in (select public.auth_company_ids()));

-- ── 4. La producción del mes, atribuida al perfil comercial ────────────────
--
-- LA CADENA DE SPONSORS ES LA MISMA QUE LA DE LA MIGRACIÓN 097, LETRA POR
-- LETRA: mismo recorte de `p0` (sólo cortan la cadena los perfiles que están EN
-- la estructura — con head_id o con gente colgando), misma normalización de
-- correo quitando el `mail.` del dominio (el CRM guarda
-- `ana.garcia@vexprofx.com` y el dashboard `ana.garcia@mail.vexprofx.com`;
-- comparando en crudo matcheaban 53 de 1.793 sponsors, quitando el `mail.`
-- matchean 114), y mismo `not in (select un from roots)` para atribuir al
-- comercial MÁS CERCANO. Si esa lógica cambia, cambia en las dos funciones.
--
-- `ib_user_id` del espejo es el `user_external_id` de `crm_user_snapshots`
-- (verificado: 23844ea3-…-c414 → millonariosteam2018, sponsor ana.garcia). Un
-- IB es un cliente más: se le sube la cadena igual que a cualquier otro.
--
-- La fila con profile_id NULL son los IB cuya cadena no llega a ningún
-- comercial de la estructura. Se DEVUELVE, no se reparte.

create or replace function public.hr_ib_production_by_profile(
  p_company_id uuid,
  p_month      date
)
returns table (
  profile_id           uuid,
  lots                 numeric,
  commission           numeric,
  pnl                  numeric,
  rewards_count        bigint,
  ibs                  bigint,
  forex_lots           numeric,
  forex_commission     numeric,
  forex_rewards        bigint,
  synthetic_lots       numeric,
  synthetic_commission numeric,
  synthetic_rewards    bigint
)
language sql
stable
set search_path to 'public'
as $function$
  with recursive
  p0 as (
    select id, head_id, email
      from commercial_profiles
     where company_id = p_company_id
  ),
  p as (
    select p0.id,
           split_part(lower(trim(p0.email)), '@', 1) || '@' ||
           replace(split_part(lower(trim(p0.email)), '@', 2), 'mail.', '') as k
      from p0
     where p0.head_id is not null
        or exists (select 1 from p0 c where c.head_id = p0.id)
  ),
  s as (
    select user_external_id,
           lower(trim(username)) as un,
           nullif(lower(trim(sponsor_username)), '') as sun,
           split_part(lower(trim(email)), '@', 1) || '@' ||
           replace(split_part(lower(trim(email)), '@', 2), 'mail.', '') as k
      from crm_user_snapshots
     where company_id = p_company_id
  ),
  roots as (select s.un, p.id as pid from s join p on p.k = s.k),
  tree as (
    select r.un, r.pid, 0 as d from roots r
    union all
    select s.un, t.pid, t.d + 1
      from s join tree t on s.sun = t.un
     where s.un not in (select un from roots) and t.d < 25
  ),
  -- El perfil de cada IB con actividad en el mes.
  ib as (
    select s.user_external_id as uid, t.pid
      from s left join tree t on t.un = s.un
  ),
  base as (
    select ib.pid,
           sum(d.lots)          as lots,
           sum(d.commission)    as commission,
           sum(d.pnl)           as pnl,
           -- sum() sobre bigint devuelve numeric; sin el cast la función falla
           -- al devolver la columna declarada bigint.
           sum(d.rewards_count)::bigint as rewards_count,
           count(distinct d.ib_user_id) as ibs
      from crm_ib_reward_daily d
      join ib on ib.uid = d.ib_user_id
     where d.company_id = p_company_id
       and d.day >= p_month
       and d.day <  (p_month + interval '1 month')
     group by ib.pid
  ),
  -- El desglose se agrega APARTE y recién después se pega: un mes sin espejo de
  -- símbolos tiene que devolver NULL en estas columnas, no cero. Si se
  -- calculara con un left join contra `base` y un coalesce, "no lo sabemos"
  -- quedaría indistinguible de "no operó sintéticos", que es exactamente el
  -- error que esta migración existe para no cometer.
  desglose as (
    select ib.pid,
           sum(x.lots)       filter (where x.asset_class = 'forex')     as forex_lots,
           sum(x.commission) filter (where x.asset_class = 'forex')     as forex_commission,
           sum(x.rewards_count) filter (where x.asset_class = 'forex')::bigint  as forex_rewards,
           sum(x.lots)       filter (where x.asset_class = 'synthetic')    as synthetic_lots,
           sum(x.commission) filter (where x.asset_class = 'synthetic')    as synthetic_commission,
           sum(x.rewards_count) filter (where x.asset_class = 'synthetic')::bigint as synthetic_rewards
      from crm_ib_reward_symbol_daily x
      join ib on ib.uid = x.ib_user_id
     where x.company_id = p_company_id
       and x.day >= p_month
       and x.day <  (p_month + interval '1 month')
     group by ib.pid
  ),
  -- La unión de claves y dos LEFT JOIN, y no un FULL JOIN: Postgres sólo acepta
  -- FULL JOIN con condiciones mergeables o hasheables, y `is not distinct from`
  -- —que es la que hace falta para que el perfil NULL de los huérfanos empareje
  -- consigo mismo— no lo es. Con FULL JOIN la función ni siquiera compila.
  claves as (select pid from base union select pid from desglose)
  select k.pid,
         round(coalesce(b.lots, 0), 4),
         round(coalesce(b.commission, 0), 2),
         round(coalesce(b.pnl, 0), 2),
         coalesce(b.rewards_count, 0),
         coalesce(b.ibs, 0),
         round(g.forex_lots, 4),
         round(g.forex_commission, 2),
         g.forex_rewards,
         round(g.synthetic_lots, 4),
         round(g.synthetic_commission, 2),
         g.synthetic_rewards
    from claves k
    left join base b     on b.pid is not distinct from k.pid
    left join desglose g on g.pid is not distinct from k.pid;
$function$;

comment on function public.hr_ib_production_by_profile(uuid, date) is
  'Produccion IB del mes (dia 1) por perfil comercial: lotes pagados, comision, '
  'PNL atribuido, cantidad de pagos por lotes y desglose forex/sinteticos. Sube '
  'la cadena de sponsors igual que hr_net_deposit_by_profile. Las columnas del '
  'desglose vienen NULL cuando el mes no esta cubierto por el espejo de '
  'simbolos: NULL es "sin dato", 0 es "no opero". El PNL es POR PERFIL y no es '
  'el PNL de la empresa (ibrewards repite el pnl una vez por nivel de IB).';

revoke all on function public.hr_ib_production_by_profile(uuid, date) from public, anon;
grant execute on function public.hr_ib_production_by_profile(uuid, date) to authenticated, service_role;

commit;
