-- Migration 007: Fix NUMERIC precision for monetary columns
-- Ensures consistent 2-decimal precision across all commission-related columns

ALTER TABLE commercial_monthly_results
  ALTER COLUMN division TYPE NUMERIC(12,2),
  ALTER COLUMN base_amount TYPE NUMERIC(12,2),
  ALTER COLUMN real_payment TYPE NUMERIC(12,2),
  ALTER COLUMN accumulated_out TYPE NUMERIC(12,2);

ALTER TABLE commercial_profiles
  ALTER COLUMN extra_pct TYPE NUMERIC(5,2);
