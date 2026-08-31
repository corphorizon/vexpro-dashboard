-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 109 — El Net Deposit deja de tener dos valores
--
-- SIN APLICAR al momento de escribirse (2026-08-31). Auditoría de finanzas,
-- ítem 11.
--
-- EL BUG (medido en PRODUCCIÓN el 2026-08-31, empresa Vex Pro)
-- ───────────────────────────────────────────────────────────────────────────
-- Las exclusiones MANUALES (`excluded_transactions`) son la forma en que un
-- admin dice «esta fila de la API no es plata de clientes»: un fondeo
-- operativo, un swap entre wallets propias, un retiro que no salió del flow.
-- Se marcan desde /movimientos/desglose y `computeProviderTotals`
-- (src/lib/api-integrations/totals.ts:96-98 y :115-117) las descuenta.
--
-- `get_period_totals_by_month` —que alimenta /balances, el gráfico mensual de
-- /resumen-general y /finanzas/consolidado vía /api/integrations/period-totals—
-- NUNCA las miró. Resultado: el MISMO Net Deposit del MISMO mes daba dos
-- números según la pantalla desde la que se preguntara.
--
--   Mes      ND /movimientos   ND /balances      Diferencia   Excluidas
--   2026-05      58.890,51        13.063,10       45.827,41    14 filas ($125.427,41)
--   2026-06     464.467,06       358.066,64      106.400,42    16 filas ($106.400,42)
--   2026-07     518.941,67       351.303,15      167.638,52    26 filas ($167.638,52)
--   ───────────────────────────────────────────────────────────
--   Total en tres meses                          319.866,35
--
-- (Julio: 26 retiros de Coinsbuy marcados como externos. Mayo mezcla las dos
--  puntas: $39.800 de depósitos y $85.627,41 de retiros.)
--
-- Y no es sólo una pantalla que informa: el Net Deposit de /balances alimenta
-- la cadena de distribución a socios. Un ND inflado en $167.638 reparte plata
-- que no entró.
--
-- LA DECISIÓN — el punto único es la RPC, no una resta del lado del cliente
-- ───────────────────────────────────────────────────────────────────────────
-- Se descartó restar las excluidas en `/api/integrations/period-totals` (TS):
-- sería una CUARTA copia de la regla «qué fila cuenta», después de la RPC,
-- `totals.ts` y `loadPersistedTotals`. El repo ya pagó ese precio (BUG-01,
-- auditoría A1). La regla vive donde vive el filtro de status y de wallets
-- pineadas: adentro de esta función.
--
-- CÓMO: un `not exists` contra `excluded_transactions` por
-- (company_id, provider, external_id) — exactamente la clave del índice ÚNICO
-- `excluded_transactions_company_id_provider_external_id_key`, así que el
-- semi-join no puede duplicar filas ni cambiar el plan a algo caro (67 filas
-- excluidas en toda la base al 2026-08-31).
--
-- Se eligió `not exists` sobre `left join ... is null` porque un left join
-- sobre una clave que HOY es única deja de ser seguro el día que alguien
-- afloje ese índice: el semi-join no cuenta dos veces por construcción.
--
-- ALCANCE: hoy sólo `coinsbuy-deposits` y `coinsbuy-withdrawals` se pueden
-- excluir (whitelist SUPPORTED_PROVIDERS en
-- src/app/api/integrations/excluded-transactions/route.ts). El predicado igual
-- se escribe genérico por provider: el día que se habilite excluir una fila de
-- UniPayment, esta función ya la respeta y no hay que acordarse de volver acá.
--
-- QUEDA AFUERA a propósito: `get_channel_day_movements` (el libro por canal)
-- sigue SIN mirar las exclusiones. Es otra pregunta —el libro cierra contra el
-- saldo REAL de la wallet, y un fondeo operativo excluido sí movió ese saldo—.
-- Tocarlo descuadraría el libro contra el proveedor. Anotado como hallazgo
-- aparte, no como olvido.
--
-- CUERPO: idéntico al vigente en producción (migración 108, verificada contra
-- `pg_proc` el 2026-08-31); lo único nuevo es el `and not exists (...)`.
--
-- VERIFICACIÓN (solo lectura, después de aplicar)
--   select * from public.get_period_totals_by_month(
--     '71715987-5479-52c4-a990-c414fb3a9b36',
--     '2026-05-01T00:00:00Z', '2026-07-31T23:59:59Z');
--   -- esperado (ensayo BEGIN/ROLLBACK del 2026-08-31):
--   --   2026-05  dep 538.811,10  ret 479.920,59
--   --   2026-06  dep 1.021.282,59 ret 556.815,53
--   --   2026-07  dep 1.433.020,85 ret 914.079,18
--
-- Idempotente: create or replace. Los grants no se tocan (076/077/078: nada de
-- anon/authenticated/PUBLIC, sólo el service role).
-- ─────────────────────────────────────────────────────────────────────────────

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
      -- lado (migración 108).
      or (t.provider = 'paypros' and t.status in ('paid', 'payout_paid'))
    )
    and (
      t.provider not in ('coinsbuy-deposits', 'coinsbuy-withdrawals')
      or p.ids is null
      or t.wallet_id = any(p.ids)
    )
    -- Exclusiones MANUALES del admin (migración 109). Espejo de
    -- `computeProviderTotals`, que filtra `t.excluded !== true`.
    and not exists (
      select 1
      from public.excluded_transactions x
      where x.company_id  = t.company_id
        and x.provider    = t.provider
        and x.external_id = t.external_id
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
