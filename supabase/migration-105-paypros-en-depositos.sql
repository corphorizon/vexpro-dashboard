-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 105 — Pay-Pros entra a los DEPÓSITOS (canal manual + RPC de totales)
--
-- SIN APLICAR al momento de escribirse (2026-08-31). Es la parte de datos del
-- arreglo que Kevin pidió: «la tarjeta Depósitos no está sumando paypros».
--
-- QUÉ PASABA
-- Pay-Pros escribe en api_transactions con provider='paypros' desde el
-- 2026-07-22 (61 filas, US$ 44.653,95 al 2026-08-31, todas status='paid' y
-- todas provenientes del espejo del CRM: external_id con prefijo 'crm:').
-- El libro diario del canal ya las contaba (RPC get_channel_day_movements,
-- migración 082) y `loadPersistedTotals` también, pero había DOS lugares que
-- no, y los dos por la misma razón: una lista dura de proveedores.
--
--   1. `deposits_channel_check` — el CHECK de la tabla de carga MANUAL solo
--      admitía coinsbuy/fairpay/unipayment/other. Todos los canales de API
--      del dashboard coexisten con una carga manual (la pantalla muestra
--      "X API + Y manual"); Pay-Pros no podía ni siquiera tener la fila.
--   2. `get_period_totals_by_month` — la RPC que alimenta /balances y
--      /finanzas/consolidado enumeraba los cuatro proveedores viejos, así que
--      los depósitos del mes salían sin Pay-Pros mientras el libro del canal
--      sí los incluía. Dos números distintos para la misma pregunta.
--
-- POR QUÉ SOLO 'paid'
-- En Pay-Pros el sentido lo dice el status: 'paid' (código 4 del webhook) es
-- plata cobrada y 'payout_paid' (código 6) es un payout ejecutado. Esta RPC
-- suma como DEPÓSITO todo lo que no sea 'coinsbuy-withdrawals', así que si
-- dejáramos entrar 'payout_paid' un retiro se sumaría como depósito. Filtrar
-- por 'paid' no esconde nada: hoy hay 0 filas 'payout_paid' y el libro del
-- canal (migración 082) es el que las contabiliza como salida.
--
-- VERIFICACIÓN SUGERIDA (solo lectura, después de aplicar)
--   select provider, status, count(*), sum(amount)
--     from public.api_transactions
--    where company_id = '71715987-5479-52c4-a990-c414fb3a9b36'
--      and provider = 'paypros' group by 1,2;
--   -- esperado hoy: paid · 61 · 44653.95
--
--   select * from public.get_period_totals_by_month(
--     '71715987-5479-52c4-a990-c414fb3a9b36',
--     '2026-08-01T00:00:00Z', '2026-08-31T23:59:59Z');
--   -- los depósitos de 2026-08 deberían subir en 44.543,95 (los $110 de
--   -- julio caen en 2026-07).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. El canal manual 'paypros' ────────────────────────────────────────────
ALTER TABLE public.deposits DROP CONSTRAINT IF EXISTS deposits_channel_check;
ALTER TABLE public.deposits
  ADD CONSTRAINT deposits_channel_check
  CHECK (channel = ANY (ARRAY['coinsbuy'::text, 'fairpay'::text, 'unipayment'::text, 'paypros'::text, 'other'::text]));

-- ── 2. get_period_totals_by_month aprende Pay-Pros ──────────────────────────
-- Cuerpo idéntico al de la migración 084 (scope de wallets operativas +
-- exclusión de transferencias internas del lado de retiros); lo único nuevo
-- es la rama de Pay-Pros en el filtro de status.
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
    AND role = 'operating'
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
    -- Status filter mirror ACCEPTED_STATUS en src/lib/api-integrations/totals.ts
    AND (
      (t.provider = 'coinsbuy-deposits' AND t.status = 'Confirmed')
      OR (t.provider = 'coinsbuy-withdrawals' AND t.status = 'Approved' AND coalesce(t.internal, false) = false)
      OR (t.provider = 'fairpay' AND t.status = 'Completed')
      OR (t.provider = 'unipayment' AND t.status = 'Completed')
      -- Pay-Pros: SOLO el depósito cobrado (ver cabecera).
      OR (t.provider = 'paypros' AND t.status = 'paid')
    )
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

-- Los grants no se tocan (CREATE OR REPLACE los conserva): ver migraciones
-- 076/077/078 — nada de anon/authenticated/PUBLIC, solo el service role.
