-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 082 — get_channel_day_movements aprende Pay-Pros
--
-- El cron diario reconstruye el libro de cada canal automático así:
--   saldo(ayer) + depósitos(hoy) − retiros(hoy) ± ajuste = saldo API(hoy)
-- y los depósitos/retiros del día salen de esta función, que hasta ahora solo
-- conocía coinsbuy-*, fairpay y unipayment. Con Pay-Pros pasando a canal
-- automático (balance por getBalance + movimientos por webhook), sin esta
-- rama TODO el delta diario caía en "ajuste de conciliación" y superaba el
-- tope → el libro abortaba cada noche con "Ajuste fuera de rango".
--
-- Pay-Pros escribe en api_transactions con provider='paypros' y un status que
-- ya distingue el sentido: 'paid' = depósito cobrado (código 4 del webhook),
-- 'payout_paid' = payout ejecutado (código 6). Los demás estados (vencido,
-- refund, payout rechazado) no mueven caja y no entran.
--
-- El resto de la función es idéntico: se agrega SOLO la rama nueva.
-- ─────────────────────────────────────────────────────────────────────────────

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
    select t.provider, t.status, t.amount, coalesce(t.internal, false) as is_internal
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
  from tx where provider = 'paypros' having count(*) > 0;
$function$;
