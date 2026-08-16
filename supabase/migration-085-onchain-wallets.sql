-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 085 — La Trust Wallet se lee sola de la blockchain
--
-- QUÉ PIDIÓ KEVIN
-- "Cambiá el balance que puse manualmente a Trust Wallet por el que da la suma
-- de las 2 wallets" y "que vaya poniendo las transacciones en el libro contable
-- de Trust Wallet". Más tarde: sumar también el gas (TRX/BNB/ETH) que se
-- mantiene ahí para validar transacciones, y ver cuánto hay en cada moneda.
--
-- LA WALLET ES INTERNA
-- Mueve plata entre wallets propias (Coinsbuy, UniPayment) y paga gastos de la
-- empresa. NO es un canal de depósito/retiro de clientes: suma al balance
-- consolidado y NO toca Net Deposit. Ver el bloque "NET DEPOSIT" más abajo.
--
-- POR QUÉ jsonb Y NO DOS COLUMNAS (onchain_network + onchain_address)
-- Porque una ubicación tiene VARIAS direcciones. Para el dueño "la Trust
-- Wallet" es UN lugar donde hay plata, aunque adentro tenga saldo en TRC20,
-- BEP20 y ERC20 (misma app, misma seed, tres cadenas con saldos
-- independientes). Con columnas escalares habría que crear tres ubicaciones y
-- sumarlas de memoria, y el libro de un solo bolsillo quedaría partido en tres.
-- Con `onchain_wallets jsonb` la fila guarda la lista y el saldo del canal es
-- la SUMA. La forma se valida con un CHECK (abajo) y con
-- `validateOnchainWallets()` en el servidor, así que "jsonb" no significa
-- "cualquier cosa".
--
-- ⚠️ NO APLICAR AUTOMÁTICAMENTE. Revisar y aplicar a mano (Kevin).
-- ─────────────────────────────────────────────────────────────────────────────

begin;

-- ── 1. Dónde viven las direcciones ──────────────────────────────────────────

alter table public.channel_configs
  add column if not exists onchain_wallets jsonb;

comment on column public.channel_configs.onchain_wallets is
  'Direcciones públicas de esta ubicación: [{"network":"tron|bsc|ethereum","address":"..."}]. '
  'Si hay al menos una, el saldo del canal lo lee el cron desde la blockchain (USDT + gas '
  'valuado) y deja de cargarse a mano. NULL o [] = ubicación manual de siempre.';

-- Validación de forma en la DB. Va como función IMMUTABLE porque un CHECK no
-- puede llevar subconsultas y la comprobación necesita recorrer el array.
-- No valida el checksum de la dirección — eso lo hace el servidor con la regex
-- por red; acá se frena lo que rompería al cron: que no sea una lista, que la
-- red no exista o que falte la dirección.
create or replace function public.onchain_wallets_valid(p jsonb)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  select p is null
      or (
        jsonb_typeof(p) = 'array'
        and not exists (
          select 1
          from jsonb_array_elements(p) as e
          where jsonb_typeof(e) <> 'object'
             or coalesce(e->>'network', '') not in ('tron', 'bsc', 'ethereum')
             or coalesce(e->>'address', '') = ''
        )
      );
$function$;

revoke all on function public.onchain_wallets_valid(jsonb) from public, anon;
grant execute on function public.onchain_wallets_valid(jsonb) to authenticated, service_role;

alter table public.channel_configs
  drop constraint if exists channel_configs_onchain_wallets_check;
alter table public.channel_configs
  add constraint channel_configs_onchain_wallets_check
  check (public.onchain_wallets_valid(onchain_wallets));

-- El cron pregunta "qué ubicaciones de esta empresa hay que leer de la cadena".
-- Índice PARCIAL: las filas on-chain son un puñado entre todas las
-- configuraciones, y un índice completo sería casi todo entradas muertas.
create index if not exists channel_configs_onchain_idx
  on public.channel_configs (company_id)
  where onchain_wallets is not null and jsonb_array_length(onchain_wallets) > 0;

-- ── 2. Desglose auditable del saldo ─────────────────────────────────────────
-- "$17.116" sin desglose es un número que no se puede reconstruir tres meses
-- después. `meta` guarda cuánto había en cada red, en cada activo, y a qué
-- precio se valuó el gas ese día. También es de dónde sale el detalle por
-- moneda que se muestra en la tarjeta de /balances (sin volver a la cadena).
alter table public.channel_balances
  add column if not exists meta jsonb;

comment on column public.channel_balances.meta is
  'Desglose del snapshot. Para ubicaciones on-chain: {kind:"onchain", total, priceAt, readAt, '
  'networks:[{network, address, usdt, native:{symbol, amount, priceUsd, valueUsd}, subtotal}]}.';

-- La RPC devuelve SETOF channel_balances: se recrea igual para que su rowtype
-- incluya la columna nueva y las pantallas reciban `meta`.
create or replace function public.channel_balances_as_of(
  p_company_id uuid,
  p_date       date
)
returns setof public.channel_balances
language sql
stable
security invoker
set search_path to 'public'
as $function$
  select distinct on (channel_key) *
  from public.channel_balances
  where company_id = p_company_id
    and snapshot_date <= p_date
  order by channel_key, snapshot_date desc, updated_at desc;
$function$;

-- ── 3. El libro aprende las transferencias on-chain ─────────────────────────
--
-- Las transferencias USDT de la wallet se persisten en `api_transactions` con
-- provider='onchain-usdt', wallet_id = LA CLAVE DEL CANAL y el sentido en
-- `status` ('received' / 'sent') — mismo patrón que Pay-Pros en la migración
-- 082. Sin esta rama, TODO el movimiento del día caería en "ajuste de
-- conciliación" y el libro no diría a quién se le pagó.
--
-- Ojo con la agrupación: los demás providers mapean a UNA clave de canal fija;
-- éste no, porque una wallet on-chain puede ser `wallet_externa` o un
-- `custom_<uuid>`. Por eso esta rama agrupa POR wallet_id, que es la clave.
--
-- Se conserva el resto de la función tal cual estaba (migración 082): solo se
-- agrega `t.wallet_id` al CTE y la rama nueva al final.
create or replace function public.get_channel_day_movements(p_company_id uuid, p_day date)
returns table(channel_key text, deposits numeric, withdrawals numeric, internal numeric)
language sql
stable
set search_path to 'public'
as $function$
  with pinned as (
    select array_agg(wallet_id) as ids
    from public.pinned_coinsbuy_wallets
    where company_id = p_company_id
  ),
  tx as (
    select t.provider, t.status, t.amount, t.wallet_id,
           coalesce(t.internal, false) as is_internal
    from public.api_transactions t
    cross join pinned p
    where t.company_id = p_company_id
      and (t.transaction_date at time zone 'UTC')::date = p_day
      and (
        (t.provider = 'coinsbuy-deposits'    and t.status = 'Confirmed')
        or (t.provider = 'coinsbuy-withdrawals' and t.status = 'Approved')
        or (t.provider = 'fairpay'           and t.status = 'Completed')
        or (t.provider = 'unipayment'        and t.status = 'Completed')
        -- Pay-Pros: un solo provider, el status dice si entra o sale.
        or (t.provider = 'paypros'           and t.status in ('paid', 'payout_paid'))
        -- Wallets on-chain: idem, el status dice el sentido.
        or (t.provider = 'onchain-usdt'      and t.status in ('received', 'sent'))
      )
      and (
        t.provider not in ('coinsbuy-deposits', 'coinsbuy-withdrawals')
        or p.ids is null
        or t.wallet_id = any(p.ids)
      )
  )
  select
    'coinsbuy'::text,
    coalesce(sum(amount) filter (where provider = 'coinsbuy-deposits'), 0),
    coalesce(sum(amount) filter (where provider = 'coinsbuy-withdrawals' and not is_internal), 0),
    coalesce(sum(amount) filter (where provider = 'coinsbuy-withdrawals' and is_internal), 0)
  from tx
  where provider like 'coinsbuy-%'
  having count(*) > 0

  union all

  select 'unipayment'::text,
         coalesce(sum(amount), 0), 0::numeric, 0::numeric
  from tx where provider = 'unipayment' having count(*) > 0

  union all

  select 'fairpay'::text,
         coalesce(sum(amount), 0), 0::numeric, 0::numeric
  from tx where provider = 'fairpay' having count(*) > 0

  union all

  select 'paypros'::text,
         coalesce(sum(amount) filter (where status = 'paid'), 0),
         coalesce(sum(amount) filter (where status = 'payout_paid'), 0),
         0::numeric
  from tx where provider = 'paypros' having count(*) > 0

  union all

  -- On-chain: una fila por CANAL (wallet_id = channel_key). La columna
  -- `internal` del libro queda en 0 a propósito: acá "interna" significa
  -- "transferencia entre wallets fijadas de Coinsbuy que no sale del agregado",
  -- y una salida de la Trust Wallet SÍ sale del saldo de este canal. Que la
  -- plata sea tesorería propia ya está resuelto en otro nivel (estas filas
  -- nunca entran a Net Deposit).
  select t.wallet_id::text,
         coalesce(sum(t.amount) filter (where t.status = 'received'), 0),
         coalesce(sum(t.amount) filter (where t.status = 'sent'), 0),
         0::numeric
  from tx t
  where t.provider = 'onchain-usdt' and t.wallet_id is not null
  group by t.wallet_id;
$function$;

revoke all on function public.get_channel_day_movements(uuid, date) from public, anon;
grant execute on function public.get_channel_day_movements(uuid, date) to authenticated, service_role;

commit;

-- ─────────────────────────────────────────────────────────────────────────────
-- NET DEPOSIT: POR QUÉ ESTA WALLET NO LO TOCA (verificado, no supuesto)
--
-- Las transferencias on-chain se guardan en api_transactions, que es la tabla
-- de la que sale Net Deposit. Se revisaron los CUATRO caminos y ninguno las ve,
-- porque todos listan los providers aceptados uno por uno:
--   · loadPersistedTotals (src/lib/api-integrations/persistence.ts): arma `by`
--     con 4 slugs y descarta cualquier fila con `if (!(slug in by)) continue`;
--     la única excepción explícita es 'paypros'.
--   · get_period_totals_by_month (migración 053): WHERE con los 4 providers
--     enumerados.
--   · reports/data.ts: `ACCEPTED_STATUS[r.provider]` → undefined → `continue`.
--   · /api/integrations/persisted-movements: consulta `.eq('provider', slug)`
--     para cada uno de los 4 slugs.
-- Además las filas van con `internal = true`, que es el segundo cinturón: los
-- agregadores que sí filtran internas también las descartan.
-- El saldo del canal, en cambio, SÍ entra al balance consolidado, porque
-- /api/balances/total-consolidado suma cualquier canal visible por su saldo de
-- libro/snapshot. Que es exactamente lo que se pidió.
--
-- Tampoco pasa por `pinned_coinsbuy_wallets`: esa tabla es solo del canal
-- Coinsbuy. Una wallet on-chain no se fija ahí ni aparece en su selector.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED PARA VEX PRO — NO SE EJECUTA EN ESTA MIGRACIÓN.
-- Descomentar y correr a mano después de revisar.
--
-- La Trust Wallet YA EXISTE como ubicación: es el canal built-in
-- `wallet_externa` (custom_label 'Trust Wallet', location_type 'wallet', con un
-- asiento manual de $17.613). NO se crea nada nuevo — se le enchufan las
-- direcciones y a partir de la próxima corrida del cron su saldo lo pone la
-- cadena. Sin unidad de negocio asignada: cae en "sin unidad", como estaba.
--
-- Las tres entradas son de la MISMA app de Trust Wallet. La dirección 0x se
-- repite en BSC y en Ethereum a propósito: es la misma seed, son dos cadenas
-- distintas y cada una tiene su propio saldo. Por eso la unicidad se valida
-- por el par (red, dirección) y no por la dirección sola.
--
-- QUÉ VA A PASAR LA PRIMERA NOCHE (esperado, no es un bug):
-- el libro venía en 17.613,00 cargado a mano y la cadena da ≈17.116
-- (17.051,70 USDT TRC20 + 0,0014 USDT BEP20 + 220,88 TRX ≈ $73 + 0,0089 BNB
-- ≈ $5). La diferencia (≈ −497) se asienta como "Ajuste de conciliación": son
-- los pagos hechos después de la última carga manual. El tope on-chain
-- (ONCHAIN_MAX_ADJUSTMENT = 50.000) lo cubre de sobra.
--
-- update public.channel_configs
--    set onchain_wallets = '[
--          {"network":"tron",     "address":"TEkSDmWk3KMxSeSK9ogefYkhEEnVtZVTkJ"},
--          {"network":"bsc",      "address":"0x321814ca95a24348551239466d778e2fc93539c9"},
--          {"network":"ethereum", "address":"0x321814ca95a24348551239466d778e2fc93539c9"}
--        ]'::jsonb,
--        location_type = 'wallet',
--        holder        = 'Trust Wallet',
--        updated_at    = now()
--  where company_id  = '71715987-5479-52c4-a990-c414fb3a9b36'
--    and channel_key = 'wallet_externa';
--
-- Verificación después de aplicar:
--   select channel_key, custom_label, location_type, holder, onchain_wallets
--     from public.channel_configs
--    where company_id = '71715987-5479-52c4-a990-c414fb3a9b36'
--      and onchain_wallets is not null;
--
-- Para volver atrás (la ubicación vuelve a ser manual, no se pierde el libro):
--   update public.channel_configs set onchain_wallets = null
--    where company_id = '71715987-5479-52c4-a990-c414fb3a9b36'
--      and channel_key = 'wallet_externa';
-- ─────────────────────────────────────────────────────────────────────────────
