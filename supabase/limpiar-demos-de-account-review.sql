-- ─────────────────────────────────────────────────────────────────────────────
-- Sacar las cuentas demo del diagnóstico operativo.
--
-- ── LA VERSIÓN ANTERIOR DE ESTE ARCHIVO NO BORRABA NADA ─────────────────────
-- Filtraba `mt5_account_review.group_name LIKE 'demo%'` y devolvía cero filas.
-- No porque no hubiera demos: porque el `group_name` que guardan las tablas del
-- CRM es un nombre corto —`SYNTHETICS`, `CENT`, `STP_Bonus1`— que es IDÉNTICO
-- en la demo y en la real. El prefijo `demo\` sólo existe en el `Group` de MT5.
--
-- La cuenta 149426 es `demo\Broker\Synthetics` en MT5 y `SYNTHETICS` a secas
-- acá. El filtro no daba error: no encontraba nada, que es peor.
--
-- ── LO QUE SÍ DISTINGUE ─────────────────────────────────────────────────────
-- `crm_trading_accounts.is_live`. Contrastado contra el `Group` de MT5 el
-- 2026-08-30: 370 cuentas, CERO desacuerdos — 36 con `is_live = false` eran
-- demo y 334 con `is_live = true` eran reales.
--
-- `is_live IS NULL` NO entra: «no sabemos» no es «es demo», y borrar por las
-- dudas se llevaría cuentas reales sin dejar rastro.
-- ─────────────────────────────────────────────────────────────────────────────

-- PASO 1 — Ver qué se va a borrar, antes de borrarlo.
SELECT r.group_name, r.account_type, COUNT(*) AS cuentas
  FROM mt5_account_review r
  JOIN crm_trading_accounts c
    ON c.login = r.login AND c.company_id = r.company_id
 WHERE c.is_live IS FALSE
 GROUP BY r.group_name, r.account_type
 ORDER BY cuentas DESC;

-- PASO 2 — Borrar.
DELETE FROM mt5_account_review r
 USING crm_trading_accounts c
 WHERE c.login = r.login
   AND c.company_id = r.company_id
   AND c.is_live IS FALSE;

-- PASO 3 — Verificar. Tiene que devolver 0.
SELECT COUNT(*) AS demos_que_quedan
  FROM mt5_account_review r
  JOIN crm_trading_accounts c
    ON c.login = r.login AND c.company_id = r.company_id
 WHERE c.is_live IS FALSE;

-- PASO 4 — Qué quedó. `sin_referencia` son las que no están en
-- `crm_trading_accounts`: no se tocaron, porque de ésas no sabemos si son demo.
SELECT COUNT(*) AS total,
       COUNT(*) FILTER (
         WHERE NOT EXISTS (
           SELECT 1 FROM crm_trading_accounts c
            WHERE c.login = r.login AND c.company_id = r.company_id)
       ) AS sin_referencia
  FROM mt5_account_review r;
