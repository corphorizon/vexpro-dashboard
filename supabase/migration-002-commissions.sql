-- Migration 002: Add commission calculator columns to commercial_monthly_results
-- These columns support the Net Deposit Commission Calculator module

ALTER TABLE commercial_monthly_results
  ADD COLUMN IF NOT EXISTS division NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_amount NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS real_payment NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accumulated_out NUMERIC DEFAULT 0;

-- Add index for efficient lookup of previous period's accumulated_out
CREATE INDEX IF NOT EXISTS idx_commercial_monthly_results_profile_period
  ON commercial_monthly_results(profile_id, period_id);

-- Add extra_pct field for HEAD differential when head_pct == bdm_pct
ALTER TABLE commercial_profiles
  ADD COLUMN IF NOT EXISTS extra_pct NUMERIC DEFAULT 0;
