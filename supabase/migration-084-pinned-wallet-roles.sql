-- ─────────────────────────────────────────────────────────────────────────────
-- Migración 084 — Rol de la wallet pineada: OPERATIVA vs INTERNA
--
-- EL BUG (confirmado en prod, Vex Pro, agosto 2026)
-- -------------------------------------------------
-- /movimientos mostraba Retiros Totales $932.444,83 y Net Deposit −$231.127.
-- La wallet operativa 1079 "VexPro Main Wallet" tenía retiros por $469.650,98.
-- La diferencia venía de otras dos wallets que también estaban pineadas:
--     · 1087 "Savings Vex Pro"  →  $400.014,00   (2 tx)
--     · 1705 "Egresos Vex"      →   $62.779,85  (22 tx)
-- Esas dos son wallets INTERNAS de la empresa (ahorro y pago de egresos):
-- mover plata ahí NO es un retiro de cliente. Con ese Net Deposit inflado en
-- negativo, la cadena de distribución repartía sobre un número falso.
-- Afectó solo julio y agosto 2026; ninguno de los dos está cerrado.
--
-- LA CAUSA RAÍZ (de concepto, no un typo)
-- ---------------------------------------
-- `pinned_coinsbuy_wallets` mezclaba DOS significados distintos:
--   (a) "esta wallet SUMA al balance consolidado"          → Balances
--   (b) "esta wallet cuenta como depósitos/retiros de CLIENTES"
--                                                          → Movimientos,
--                                                            Net Deposit,
--                                                            distribución
-- Mientras la única wallet pineada era Main, (a) y (b) coincidían. Al pinnear
-- Savings y Egresos para que sumaran al BALANCE, Movimientos se las llevó
-- puestas porque leía la misma tabla sin distinguir.
--
-- LA SOLUCIÓN (modelo, no parche)
-- -------------------------------
-- Cada wallet pineada declara su ROL:
--   · 'operating' → cuenta como depósitos/retiros de clientes Y suma al balance
--   · 'internal'  → SOLO suma al balance; sus movimientos no entran a
--                   Net Deposit ni a la cadena de distribución
-- Puede haber VARIAS operativas (decisión de Kevin: "debe permitir pinnear más
-- si se desea"). El DEFAULT es 'operating' para no cambiarle el número a
-- ninguna otra empresa: el resto de los tenants solo tiene su wallet Main
-- pineada, que es justamente la operativa.
--
-- NO aplicar a mano sin revisar: esta migración toca cómo se calcula el dinero.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Columna de rol ────────────────────────────────────────────────────────
alter table public.pinned_coinsbuy_wallets
  add column if not exists role text not null default 'operating'
    check (role in ('operating', 'internal'));

comment on column public.pinned_coinsbuy_wallets.role is
  'operating = cuenta como depósitos/retiros de clientes y suma al balance; '
  'internal = SOLO suma al balance consolidado (ahorro, pago de egresos, etc). '
  'Ver migración 084: en agosto 2026 las wallets internas de Vex Pro inflaron '
  'Retiros Totales en $462.793,85 y dejaron el Net Deposit negativo.';

-- Índice parcial para el camino caliente (Movimientos pide SOLO las
-- operativas en cada carga de la pantalla).
create index if not exists idx_pinned_wallets_operating
  on public.pinned_coinsbuy_wallets(company_id)
  where role = 'operating';

-- ── 2. Datos: Vex Pro ────────────────────────────────────────────────────────
-- 1087 (Savings Vex Pro) y 1705 (Egresos Vex) pasan a 'internal'. 1079
-- (VexPro Main Wallet) queda 'operating' por el default.
-- Con esto, agosto 2026 debería mostrar Retiros Totales ≈ $469.650,98
-- (los de la Main) en vez de $932.444,83, y Net Deposit positivo.
update public.pinned_coinsbuy_wallets
   set role = 'internal'
 where company_id = '71715987-5479-52c4-a990-c414fb3a9b36'
   and wallet_id in ('1087', '1705');

-- ── 3. RPC get_period_totals_by_month → SOLO wallets operativas ──────────────
-- Esta RPC alimenta /balances ("Balance Actual Disponible") y la tabla de
-- /finanzas/consolidado: son depósitos y retiros del período, o sea semántica
-- de MOVIMIENTOS. Por eso pasa a scopear por role='operating'.
-- (La RPC get_channel_day_movements de la migración 059 se queda con TODAS las
-- pineadas a propósito: ese es el LIBRO del canal coinsbuy, o sea BALANCE.)
-- Resto del cuerpo idéntico a la versión de la migración 053 (filtro de
-- status + exclusión de transferencias internas del lado de retiros).
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
    -- Solo operativas: las internas (ahorro / egresos) suman al balance pero
    -- NO son depósitos ni retiros de clientes (migración 084).
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
    -- Status filter mirror ACCEPTED_STATUS in route.ts
    -- Retiros: además excluimos transferencias internas entre wallets
    -- propias (internal = true). Los depósitos NO llevan este filtro.
    AND (
      (t.provider = 'coinsbuy-deposits' AND t.status = 'Confirmed')
      OR (t.provider = 'coinsbuy-withdrawals' AND t.status = 'Approved' AND coalesce(t.internal, false) = false)
      OR (t.provider = 'fairpay' AND t.status = 'Completed')
      OR (t.provider = 'unipayment' AND t.status = 'Completed')
    )
    -- Wallet scoping for Coinsbuy rows (when operating wallets configured)
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

-- Los grants de la RPC no se tocan (CREATE OR REPLACE los conserva); ver
-- migraciones 076/077/078: nada de anon/authenticated/PUBLIC, solo el service
-- role que usa el endpoint.

-- ── Verificación sugerida (solo lectura, después de aplicar) ─────────────────
--   select wallet_id, wallet_label, role
--     from public.pinned_coinsbuy_wallets
--    where company_id = '71715987-5479-52c4-a990-c414fb3a9b36';
--   -- 1079 operating · 1087 internal · 1705 internal
--
--   select * from public.get_period_totals_by_month(
--     '71715987-5479-52c4-a990-c414fb3a9b36',
--     '2026-08-01T00:00:00Z', '2026-08-31T23:59:59Z');
--   -- withdrawals debería bajar a los retiros de la wallet 1079
