-- Migration 008: Add fixed_salary flag to commercial_profiles
-- When true, the user's salary is fixed (not tied to ND tiers)
-- When false (default), salary is auto-calculated from Net Deposit tiers

ALTER TABLE commercial_profiles
  ADD COLUMN IF NOT EXISTS fixed_salary BOOLEAN DEFAULT false;
