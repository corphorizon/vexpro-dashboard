-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 053 — Transferencias internas entre wallets propias (Coinsbuy)
--
-- Regla de negocio (verificada contra la API v3 de Coinsbuy el 2026-08-03):
-- un transfer de retiro (op_type=2) con txid null/vacío es una transferencia
-- INTERNA entre wallets propias de la empresa (ej. Savings→Main; confirmado:
-- transfer 2331264 de $30,000 del 2026-07-18 con txid=null = payout 350270
-- con address=null + target_wallet=1079). Los retiros externos siempre
-- tienen txid de blockchain al confirmarse.
--
-- Las transferencias internas NO cuentan en Retiros Totales ni en Net
-- Deposit: es plata que nunca salió de la empresa. El lado receptor NO
-- aparece como depósito (verificado), así que solo hay que filtrar el lado
-- de retiros. Los depósitos NO se tocan.
--
-- Esto es independiente de las exclusiones manuales del admin
-- (excluded_transactions), que siguen funcionando igual.
--
-- 1) Columna `internal` en api_transactions (los fetchers v3 la setean en
--    el upsert; las filas viejas quedan en false hasta el backfill).
-- 2) Índice parcial para las agregaciones que filtran internas.
-- 3) RPC get_period_totals_by_month actualizada: excluye internas SOLO del
--    lado de retiros.
--
-- Backfill sugerido (correr después de aplicar, dentro de BEGIN/ROLLBACK
-- primero para verificar el alcance):
--   update api_transactions
--     set internal = true
--   where provider = 'coinsbuy-withdrawals'
--     and coalesce(raw->>'trackingId', '') = '';
-- ─────────────────────────────────────────────────────────────────────────────

alter table api_transactions add column internal boolean not null default false;

-- Índice parcial: las internas son pocas; el índice solo las cubre a ellas,
-- así el filtro `where internal` de reportes/agregaciones es barato.
create index if not exists idx_api_tx_internal
  on api_transactions(company_id, provider)
  where internal;

-- ── RPC actualizada ──────────────────────────────────────────────────────────
-- Igual a la definición vigente (aplicada inline el 2026-06-07, hardening de
-- grants en migración 051) + el filtro de internas en el lado de retiros.
-- coalesce(internal,false) por si alguna fila vieja tuviera null (la columna
-- es NOT NULL DEFAULT false, pero el coalesce hace la intención explícita).
CREATE OR REPLACE FUNCTION public.get_period_totals_by_month(p_company_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(month text, deposits numeric, withdrawals numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH pinned AS (
  SELECT array_agg(wallet_id) AS ids
  FROM public.pinned_coinsbuy_wallets
  WHERE company_id = p_company_id
),
filtered AS (
  SELECT
    TO_CHAR(t.transaction_date, 'YYYY-MM') AS month,
    t.provider,
    t.amount
  FROM public.api_transactions t
  CROSS JOIN pinned p
  WHERE t.company_id = p_company_id
    AND t.transaction_date >= p_from
    AND t.transaction_date <= p_to
    -- Status filter mirror ACCEPTED_STATUS in route.ts
    -- Retiros: además excluimos transferencias internas entre wallets
    -- propias (internal = true). Los depósitos NO llevan este filtro.
    AND (
      (t.provider = 'coinsbuy-deposits' AND t.status = 'Confirmed')
      OR (t.provider = 'coinsbuy-withdrawals' AND t.status = 'Approved' AND coalesce(t.internal, false) = false)
      OR (t.provider = 'fairpay' AND t.status = 'Completed')
      OR (t.provider = 'unipayment' AND t.status = 'Completed')
    )
    -- Wallet scoping for Coinsbuy rows (when pinned wallets configured)
    AND (
      t.provider NOT IN ('coinsbuy-deposits', 'coinsbuy-withdrawals')
      OR p.ids IS NULL
      OR t.wallet_id = ANY(p.ids)
    )
)
SELECT
  month,
  COALESCE(SUM(amount) FILTER (WHERE provider != 'coinsbuy-withdrawals'), 0)::numeric AS deposits,
  COALESCE(SUM(amount) FILTER (WHERE provider = 'coinsbuy-withdrawals'), 0)::numeric AS withdrawals
FROM filtered
GROUP BY month
ORDER BY month;
$function$;
