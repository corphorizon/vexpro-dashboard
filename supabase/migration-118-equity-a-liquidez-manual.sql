-- APLICADA EL 2026-08-31. El número NO indica el orden real: nació con otro
-- (105/106/107/108) y se renumeró al chocar con las del equipo, que iban por la
-- 115. Ver la nota de numeración en docs/reglas-del-proyecto.md §0.

-- ─────────────────────────────────────────────────────────────────────────────
-- migration-118 — El "Equity a Liquidez" se puede corregir a mano.
--
-- ── QUÉ RESUELVE ────────────────────────────────────────────────────────────
-- `balance_liquidez` —que en pantalla ahora se llama "Equity a Liquidez"— es
-- cuánto aporta la cuenta al pool. Hasta ahora lo decidía SÓLO el análisis de
-- duplicados al dar de alta la cuenta.
--
-- Pero el monto REAL que se envió a liquidez lo sabe la persona, no el análisis:
-- éste sólo puede inferirlo de lo que ve en MT5 y en el CRM. Cuando el análisis
-- no acierta, hasta hoy no había forma de corregirlo.
--
-- ── POR QUÉ ES SEGURO DEJARLO EDITABLE ─────────────────────────────────────
-- Porque el refresh NUNCA lo tocó, y esa regla no cambia. Si el refresh lo
-- recalculara en cada corrida, una transferencia detectada hace un mes se
-- volvería a descontar y el pool encogería solo hasta cero sin que nadie lo
-- note. Esto sólo agrega quién más puede escribirlo, no cuándo se recalcula.
--
-- La marca sirve para que la pantalla distinga un monto propuesto por el
-- análisis de uno decidido por una persona. Sin ella, los dos se ven igual y
-- no hay forma de saber cuál revisar.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE platform_liquidity_accounts
  ADD COLUMN IF NOT EXISTS liquidez_manual boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN platform_liquidity_accounts.liquidez_manual IS
  'true = el "Equity a Liquidez" (balance_liquidez) se cargó a mano y no lo '
  'pisa ningún cálculo. false = lo propuso el análisis de duplicados al dar de '
  'alta la cuenta. El refresh no toca balance_liquidez en ningún caso.';

-- Verificación — tiene que devolver una fila.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'platform_liquidity_accounts'
   AND column_name = 'liquidez_manual';
