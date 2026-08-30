-- ─────────────────────────────────────────────────────────────────────────────
-- Sacar las cuentas demo del diagnóstico operativo.
--
-- ── QUÉ PASÓ ────────────────────────────────────────────────────────────────
-- El revisor de cuentas no aplicaba la regla de demo que el repo ya tenía en
-- `mt5-sync/pnl.ts` y `mt5-sync/exposure.ts` (`Group NOT LIKE 'demo%'`). El
-- código ya la aplica; esto borra lo que se guardó antes.
--
-- Medido el 2026-08-28 en Vex Pro: 2.290 cuentas demo, 1.496 sólo en
-- `demo\Broker\Synthetics`. Diagnosticarlas gasta presupuesto de consultas a
-- MT5 y ensucia la ficha de retiros con señales sobre dinero que no existe.
--
-- ── POR QUÉ BORRAR Y NO MARCAR ──────────────────────────────────────────────
-- Porque no hay ningún caso en que se quieran leer. El diagnóstico se rehace
-- solo por rotación, así que si alguna vez hiciera falta, alcanza con volver a
-- incluirlas en el sync.
-- ─────────────────────────────────────────────────────────────────────────────

-- PASO 1 — Ver cuántas y de qué grupos, antes de borrar.
SELECT group_name, COUNT(*) AS cuentas
  FROM mt5_account_review
 WHERE lower(group_name) LIKE 'demo%'
 GROUP BY group_name
 ORDER BY cuentas DESC;

-- PASO 2 — Borrar.
--
-- `lower(...)` para que no dependa de mayúsculas, igual que `esGrupoDemo()`.
-- `group_name` en NULL NO entra: «no sabemos el grupo» no es «es demo», y
-- borrar por las dudas se llevaría cuentas reales sin dejar rastro.
DELETE FROM mt5_account_review
 WHERE lower(group_name) LIKE 'demo%';

-- PASO 3 — Verificar. Tiene que devolver 0.
SELECT COUNT(*) AS demos_que_quedan
  FROM mt5_account_review
 WHERE lower(group_name) LIKE 'demo%';

-- PASO 4 — De paso, ver cuántas quedan en total y cuántas sin grupo conocido.
SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE group_name IS NULL) AS sin_grupo
  FROM mt5_account_review;
