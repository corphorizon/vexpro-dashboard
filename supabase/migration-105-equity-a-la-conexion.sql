-- ─────────────────────────────────────────────────────────────────────────────
-- migration-105 — El equity que tenía una cuenta EN SU FECHA DE CONEXIÓN.
--
-- ── QUÉ RESUELVE ────────────────────────────────────────────────────────────
-- `equity_at_connection` ya existía, pero al dar de alta una cuenta retroactiva
-- se guardaba el balance de HOY. En una cuenta que ya venía operando eso es
-- otro número: un dato plausible en un campo que dice otra cosa.
--
-- El código ahora lo reconstruye desde `mt5_deals`:
--   saldo_en_T = balance_de_hoy − (todo lo que movió el saldo desde T)
--
-- Estas dos columnas son lo que falta para que ese cálculo sea honesto sobre
-- sus propios límites y para que no pise lo que se cargue a mano.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE platform_liquidity_accounts
  ADD COLUMN IF NOT EXISTS connection_values_manual  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connection_open_positions integer;

COMMENT ON COLUMN platform_liquidity_accounts.connection_values_manual IS
  'true = el equity a la conexión se escribió a mano. Un recálculo por cambio '
  'de fecha respeta la marca en vez de pisarlo: sin esto, el valor cargado a '
  'mano se perdería en silencio dejando un número con cara de correcto. '
  'Vaciar el campo en la pantalla suelta la marca y devuelve el control al '
  'cálculo automático.';

COMMENT ON COLUMN platform_liquidity_accounts.connection_open_positions IS
  'Posiciones abiertas en el instante de conexión. El equity es el balance MÁS '
  'el flotante de esas posiciones, y el flotante depende del precio de mercado '
  'de ese momento, que mt5_deals no guarda. '
  'NULL = no se calculó (dato ausente, la pantalla muestra un guion). '
  '0 = no había flotante, entonces equity = balance y el número es EXACTO. '
  '>0 = el equity real era otro; la pantalla lo marca "aprox." y se puede '
  'corregir a mano. NULL y 0 no son lo mismo.';

-- Verificación — las dos columnas tienen que aparecer.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'platform_liquidity_accounts'
   AND column_name IN ('connection_values_manual', 'connection_open_positions')
 ORDER BY column_name;
