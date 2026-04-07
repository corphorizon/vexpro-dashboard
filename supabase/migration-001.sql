-- Migration 001: Add columns added after initial schema deploy
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/krohysnnppwcetdjhyyz/sql

-- 1. Commercial profiles: hire_date and birthday
ALTER TABLE commercial_profiles
  ADD COLUMN IF NOT EXISTS hire_date DATE,
  ADD COLUMN IF NOT EXISTS birthday DATE;

-- 2. Commercial monthly results: rename pnl -> pnl_current, add pnl_accumulated and pnl_total
-- First check if pnl column exists and rename it
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'commercial_monthly_results' AND column_name = 'pnl') THEN
    ALTER TABLE commercial_monthly_results RENAME COLUMN pnl TO pnl_current;
  END IF;
END $$;

ALTER TABLE commercial_monthly_results
  ADD COLUMN IF NOT EXISTS pnl_current NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pnl_accumulated NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pnl_total NUMERIC DEFAULT 0;

-- 3. Employees: birthday, supervisor, comments
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS birthday DATE,
  ADD COLUMN IF NOT EXISTS supervisor TEXT,
  ADD COLUMN IF NOT EXISTS comments TEXT;

-- Verify
SELECT 'commercial_profiles' as tbl, column_name FROM information_schema.columns WHERE table_name = 'commercial_profiles' AND column_name IN ('hire_date', 'birthday')
UNION ALL
SELECT 'commercial_monthly_results', column_name FROM information_schema.columns WHERE table_name = 'commercial_monthly_results' AND column_name IN ('pnl_current', 'pnl_accumulated', 'pnl_total')
UNION ALL
SELECT 'employees', column_name FROM information_schema.columns WHERE table_name = 'employees' AND column_name IN ('birthday', 'supervisor', 'comments');
