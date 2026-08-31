-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 108 — El libro de FairPay deja de mentir · Pay-Pros suma en retiros
--
-- SIN APLICAR al momento de escribirse (2026-08-31). Son las dos partes de
-- datos de los dos encargos de Kevin del mismo día:
--   «fairpay sigue sin sumar en balances por canal»
--   «de paypros en movimientos incluí también los retiros por ese medio»
--
-- ═════════════════════════════════════════════════════════════════════════════
-- 1. get_channel_day_movements DEJA de devolver 'fairpay'
-- ═════════════════════════════════════════════════════════════════════════════
--
-- QUÉ PASABA (el bug que Kevin ve)
-- El canal `fairpay` tenía snapshot diario (hoy $7.163,47, verificado contra
-- banking.fairpay.online) pero su LIBRO tenía un único asiento: una apertura
-- MANUAL de $0,00 fechada el 2026-08-05. Y el libro le gana al snapshot en las
-- dos pantallas que muestran el saldo (getChannelValue en /balances y
-- pickChannelAmount en src/lib/reports/balances-by-channel.ts, prioridad fijada
-- por la auditoría A1). Resultado: FairPay salía en $0,00 desde el 2026-08-05 y
-- el total consolidado venía corto por $7.163,47.
--
-- La raíz es la de la migración 059: **un canal de API tiene libro
-- AUTOMÁTICO**. FairPay tenía saldo por API y libro huérfano. El arreglo del
-- lado del código es que entre a `API_LEDGER_CHANNELS` y que el cron de las
-- 00:00 UTC le escriba su línea diaria (src/lib/channel-ledger.ts +
-- src/app/api/cron/daily-balance-snapshot/route.ts).
--
-- POR QUÉ HAY QUE SACAR LA RAMA DE ESTA FUNCIÓN
-- El cron arma el día de un canal automático así:
--   saldo(ayer) + depósitos(hoy) − retiros(hoy) ± ajuste = saldo API(hoy)
-- y los depósitos/retiros salen de acá. Si FairPay siguiera devolviendo su
-- fila, el libro asentaría como «Depósitos del día» de la CUENTA BANCARIA unas
-- filas que no son de esa cuenta, por dos razones independientes y cada una
-- suficiente:
--
--   a) SON DOS SISTEMAS DISTINTOS. `api_transactions.provider='fairpay'` son
--      cobros de portal.fairpay.online; el saldo sale de
--      banking.fairpay.online, que es otro producto con otras credenciales y
--      que NO expone extracto (barrido de ~150 rutas con la credencial real de
--      Vex Pro el 2026-08-17: todas 404 — ver la cabecera de
--      src/lib/api-integrations/fairpay/balances.ts). No liquidan 1:1: en
--      agosto 2026 el portal registró cobros casi todos los días y el banking
--      se movió DOS veces (0 → 6.747,05 el 18/08 → 7.163,47 el 25/08). Cada
--      día habría asentado un depósito y un ajuste igual y opuesto: ficción
--      contable de las dos puntas.
--
--   b) LA MONEDA. Esas filas suman monedas LOCALES como si fueran USD. Medido
--      el 2026-08-31 sobre agosto: conviven COP, CLP, CRC, MXN, BRL y USD en
--      `amount`, y el 2026-08-12 hay $145.714,40 de tres monedas distintas
--      sumados como dólares. **Es un hallazgo grave, pendiente de decisión de
--      Kevin, y NO se arregla en esta migración** — se documenta acá porque es
--      la segunda razón por la que estas filas no pueden entrar a un libro que
--      cierra contra un saldo en USD. Cuando se decida qué hacer con la
--      moneda, revisar también get_period_totals_by_month y
--      loadPersistedTotals, que hoy las suman igual.
--
-- QUÉ QUEDA EN SU LUGAR
-- El día de FairPay se asienta con UNA sola línea, categoría `balance_delta`
-- («Variación del saldo»), que es la variación real del saldo informado por la
-- API. No se disfraza de «Ajuste de conciliación»: no es la corrección de un
-- desvío, es el movimiento del día, del que conocemos el importe y no el
-- desglose. La aritmética del cierre es idéntica (computeTotals la suma como
-- ajuste), lo que cambia es el nombre que lee la persona.
--
-- NADIE MÁS CONSUME ESTA FILA: `get_channel_day_movements` la llama únicamente
-- `syncChannelLedgerDay` (src/lib/channel-ledger-sync.ts). Verificado por grep
-- sobre src/ y scripts/ el 2026-08-31.
--
-- BACKFILL: el libro de FairPay arranca vacío salvo la apertura de $0,00. Para
-- que la pantalla muestre $7.163,47 hay que replicar los días históricos desde
-- los snapshots ya guardados:
--   npx tsx scripts/backfill-channel-ledger.ts fairpay --company "Vex Pro"
--   npx tsx scripts/backfill-channel-ledger.ts fairpay --company "Vex Pro" --apply
-- (el ensayo imprime día por día; sin --apply no escribe nada).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- 2. get_period_totals_by_month aprende los RETIROS de Pay-Pros
-- ═════════════════════════════════════════════════════════════════════════════
--
-- La migración 105 le enseñó a esta RPC los DEPÓSITOS de Pay-Pros (status
-- 'paid') y dejó los 'payout_paid' afuera con una razón explícita: «hoy hay 0
-- filas 'payout_paid'». Eso cambia con este trabajo: el espejo del CRM ahora
-- proyecta los retiros aprobados por Pay-Pros a `api_transactions` con status
-- 'payout_paid' (src/lib/api-integrations/paypros/withdrawals-from-crm.ts).
--
-- Sin esta parte, la RPC —que alimenta el gráfico mensual de /balances y
-- /finanzas/consolidado— sería la ÚNICA que no los cuenta, mientras el libro
-- del canal (migración 082), `loadPersistedTotals` y /movimientos sí. Dos
-- números distintos para la misma pregunta es exactamente lo que la 105 vino a
-- cerrar del lado de los depósitos.
--
-- OJO CON EL `SELECT` DE ABAJO: suma como depósito todo lo que no sea
-- 'coinsbuy-withdrawals'. Por eso los payouts de Pay-Pros necesitan que el
-- FILTER de retiros y el de depósitos los nombren explícitamente, y no basta
-- con dejarlos pasar en el WHERE.
--
-- VERIFICACIÓN SUGERIDA (solo lectura, después de aplicar)
--   select * from public.get_channel_day_movements(
--     '71715987-5479-52c4-a990-c414fb3a9b36', '2026-08-28');
--   -- ya NO debe aparecer la fila 'fairpay'.
--
--   select * from public.get_period_totals_by_month(
--     '71715987-5479-52c4-a990-c414fb3a9b36',
--     '2026-08-01T00:00:00Z', '2026-08-31T23:59:59Z');
--   -- los retiros de 2026-08 suben en lo que traiga el espejo de Pay-Pros
--   -- (al 2026-08-31: 6 retiros aprobados, US$ 2.617,62 por requested_amount).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. get_channel_day_movements sin FairPay ────────────────────────────────
-- Cuerpo idéntico al vigente (migración 085: Pay-Pros + on-chain); lo único
-- que cambia es que la rama 'fairpay' desaparece del WHERE y del UNION.
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
        or (t.provider = 'unipayment'        and t.status = 'Completed')
        -- Pay-Pros: un solo provider, el status dice si entra o sale.
        or (t.provider = 'paypros'           and t.status in ('paid', 'payout_paid'))
        -- Wallets on-chain: idem, el status dice el sentido.
        or (t.provider = 'onchain-usdt'      and t.status in ('received', 'sent'))
        -- 'fairpay' NO está: sus filas son del portal de cobros y el saldo del
        -- canal es el de la cuenta bancaria. Ver la cabecera, punto 1.
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

-- ── 2. get_period_totals_by_month cuenta los payouts de Pay-Pros ────────────
-- Cuerpo idéntico al de la migración 105; lo nuevo es 'payout_paid' en el
-- filtro de status y los dos FILTER de abajo, que ahora nombran el sentido en
-- vez de dar por hecho que "todo lo que no es coinsbuy-withdrawals entra".
create or replace function public.get_period_totals_by_month(p_company_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 returns table(month text, deposits numeric, withdrawals numeric)
 language sql
 security definer
 set search_path to 'public'
as $function$
with pinned as (
  select array_agg(wallet_id) as ids
  from public.pinned_coinsbuy_wallets
  where company_id = p_company_id
    and role = 'operating'
),
filtered as (
  select
    to_char(t.transaction_date, 'YYYY-MM') as month,
    t.provider,
    t.status,
    t.amount
  from public.api_transactions t
  cross join pinned p
  where t.company_id = p_company_id
    and t.transaction_date >= p_from
    and t.transaction_date <= p_to
    -- Status filter mirror ACCEPTED_STATUS en src/lib/api-integrations/totals.ts
    and (
      (t.provider = 'coinsbuy-deposits' and t.status = 'Confirmed')
      or (t.provider = 'coinsbuy-withdrawals' and t.status = 'Approved' and coalesce(t.internal, false) = false)
      or (t.provider = 'fairpay' and t.status = 'Completed')
      or (t.provider = 'unipayment' and t.status = 'Completed')
      -- Pay-Pros: 'paid' entra, 'payout_paid' sale. Los dos, cada uno de su
      -- lado (ver cabecera, punto 2).
      or (t.provider = 'paypros' and t.status in ('paid', 'payout_paid'))
    )
    and (
      t.provider not in ('coinsbuy-deposits', 'coinsbuy-withdrawals')
      or p.ids is null
      or t.wallet_id = any(p.ids)
    )
)
select
  month,
  coalesce(sum(amount) filter (
    where provider <> 'coinsbuy-withdrawals'
      and not (provider = 'paypros' and status = 'payout_paid')
  ), 0)::numeric as deposits,
  coalesce(sum(amount) filter (
    where provider = 'coinsbuy-withdrawals'
       or (provider = 'paypros' and status = 'payout_paid')
  ), 0)::numeric as withdrawals
from filtered
group by month
order by month;
$function$;

-- Los grants no se tocan (create or replace los conserva): ver migraciones
-- 076/077/078 — nada de anon/authenticated/PUBLIC, solo el service role.
