-- Migration 019: allow multiple manual withdrawal entries per period
--
-- Adds an optional `description` column to the `withdrawals` table so the
-- Carga de Datos UI can keep the four fixed category aggregates AND let
-- users append arbitrary extra rows with a label. Many rows per
-- (company, period, category) are already allowed by the schema — the
-- upsertWithdrawals mutation just did delete+reinsert of the four-row
-- shape until now.

BEGIN;

ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS description text;

COMMENT ON COLUMN withdrawals.description IS
  'Optional free-form label for manual extra entries (paid to X, reason, etc.). NULL for the canonical per-category aggregate row.';

COMMIT;
