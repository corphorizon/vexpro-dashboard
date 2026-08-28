-- ─────────────────────────────────────────────────────────────────────────────
-- Repara las fechas de conexión guardadas con el ancla vieja de mediodía.
--
-- ── QUÉ PASÓ ────────────────────────────────────────────────────────────────
-- La validación anclaba el `YYYY-MM-DD` del formulario a las 12:00 UTC, así que
-- el PnL del mes de conexión se perdía las operaciones de esa mañana. Medido en
-- la cuenta 136773: -2.662,49 contra los -3.437,67 del MT5 Manager; faltaban 17
-- operaciones del 06/03 entre las 02h y las 03h, que netean -775,18.
--
-- El código ya guarda 00:00. Esto arregla las filas escritas antes.
--
-- ── POR QUÉ NO ALCANZA CON APRETAR "REFRESCAR" ─────────────────────────────
-- El refresh SÍ recalcula el PnL, pero lo hace desde la `connection_date`
-- guardada. Mientras esa fecha siga en mediodía, recalcular da exactamente el
-- mismo número equivocado. Primero hay que mover la fecha; después el refresh
-- rehace los meses.
-- ─────────────────────────────────────────────────────────────────────────────

-- PASO 1 — Ver qué se va a tocar. Hoy debería salir sólo la cuenta 136773.
SELECT mt5_account,
       connection_date AS antes,
       date_trunc('day', connection_date AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS despues
  FROM platform_liquidity_accounts
 WHERE connection_date
       <> date_trunc('day', connection_date AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

-- PASO 2 — Normalizar al arranque del día, en UTC.
--
-- El `AT TIME ZONE 'UTC'` de los dos lados no es adorno: `date_trunc` sobre un
-- `timestamptz` corta según la zona de la sesión. Sin fijarla, correr esto
-- desde una sesión en otra zona movería la fecha un día.
--
-- El WHERE lo hace idempotente: las filas que ya están en 00:00 no se tocan, y
-- correrlo dos veces afecta 0 filas la segunda vez.
UPDATE platform_liquidity_accounts
   SET connection_date = date_trunc('day', connection_date AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
       updated_at      = now()
 WHERE connection_date
       <> date_trunc('day', connection_date AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

-- PASO 3 — Verificar. Tiene que devolver 0 filas.
SELECT COUNT(*) AS filas_sin_normalizar
  FROM platform_liquidity_accounts
 WHERE connection_date
       <> date_trunc('day', connection_date AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

-- PASO 4 — En la pantalla: "Refrescar todo".
-- El PnL guardado se rehace desde la fecha nueva. Recién ahí marzo de la
-- cuenta 136773 tiene que dar -3.437,67 con 481 operaciones.
