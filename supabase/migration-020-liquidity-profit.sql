-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 020: add optional `profit` column to liquidity_movements
--
-- Mirrors the `profit` column already present in `investments`. Used to record
-- gains/losses on a liquidity movement that aren't a straight deposit or
-- withdrawal (e.g. bank fees, FX variations, transfer shortfalls, interest).
--
-- Default 0 so existing rows don't need backfill. Frontend treats NULL and 0
-- identically.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE liquidity_movements
  ADD COLUMN IF NOT EXISTS profit NUMERIC(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN liquidity_movements.profit IS
  'Ganancia/pérdida del movimiento (positivo = ganancia, negativo = pérdida). Se suma al running balance junto con deposit − withdrawal.';
