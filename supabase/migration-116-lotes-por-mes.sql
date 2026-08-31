-- APLICADA EL 2026-08-31. El número NO indica el orden real: nació con otro
-- (105/106/107/108) y se renumeró al chocar con las del equipo, que iban por la
-- 115. Ver la nota de numeración en docs/reglas-del-proyecto.md §0.

-- ─────────────────────────────────────────────────────────────────────────────
-- migration-116 — Lotes operados por mes en el pool de liquidez.
--
-- El resumen mensual mostraba PnL y operaciones. Faltaba el VOLUMEN: dos
-- cuentas con el mismo resultado no son lo mismo si una movió 2 lotes y la otra
-- 400. Es la medida de cuánto trabajo hizo la cuenta para llegar a ese número.
--
-- ── DE DÓNDE SALE, Y POR QUÉ NO DE `Volume` ────────────────────────────────
-- De `SUM(VolumeClosed)` sobre los deals de salida, dividido 10.000.
--
-- `Volume` y `VolumeClosed` dan el MISMO resultado —437,66 lotes medidos en la
-- cuenta 137983— pero `VolumeClosed` está dentro de
-- `idx_deals_login_timemsc_entry` y `Volume` no. Con el primero el plan dice
-- `Using index`; con el segundo hay que ir a buscar la fila.
--
-- Medido: 140 ms contra 316 ms. Y la regla G6 del repo documenta el caso
-- grande: sumar `Volume` pasó de 345 ms a 13.221 ms, 38 veces más.
--
-- ── LO QUE PASA CON LO YA CALCULADO ────────────────────────────────────────
-- Las filas viejas quedan en NULL, que es «no se calculó» — distinto de cero
-- lotes, que sería «no operó». La pantalla muestra un guion hasta que se
-- refresque la cuenta.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE platform_liquidity_monthly_pnl
  ADD COLUMN IF NOT EXISTS lots numeric;

COMMENT ON COLUMN platform_liquidity_monthly_pnl.lots IS
  'Lotes cerrados en el mes: SUM(VolumeClosed)/10000 sobre los deals de salida. '
  'VolumeClosed y no Volume porque el primero está en el índice cubriente '
  '(regla G6). NULL = calculado antes de la migración 116, no es cero lotes.';

-- Verificación — tiene que devolver una fila.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'platform_liquidity_monthly_pnl'
   AND column_name = 'lots';
