-- migration-013-fix-insert-policies.sql
-- Fix INSERT policies: add WITH CHECK constraints to prevent cross-tenant inserts.
-- Previously, INSERT policies had no WITH CHECK, allowing any authenticated user
-- to insert rows with any company_id.

-- Drop and recreate INSERT policies for all tables that have them

-- deposits
DROP POLICY IF EXISTS "deposits_insert" ON deposits;
CREATE POLICY "deposits_insert" ON deposits
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- withdrawals
DROP POLICY IF EXISTS "withdrawals_insert" ON withdrawals;
CREATE POLICY "withdrawals_insert" ON withdrawals
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- expenses
DROP POLICY IF EXISTS "expenses_insert" ON expenses;
CREATE POLICY "expenses_insert" ON expenses
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- preoperative_expenses
DROP POLICY IF EXISTS "preoperative_expenses_insert" ON preoperative_expenses;
CREATE POLICY "preoperative_expenses_insert" ON preoperative_expenses
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- operating_income
DROP POLICY IF EXISTS "operating_income_insert" ON operating_income;
CREATE POLICY "operating_income_insert" ON operating_income
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- broker_balance
DROP POLICY IF EXISTS "broker_balance_insert" ON broker_balance;
CREATE POLICY "broker_balance_insert" ON broker_balance
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- financial_status
DROP POLICY IF EXISTS "financial_status_insert" ON financial_status;
CREATE POLICY "financial_status_insert" ON financial_status
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- partners
DROP POLICY IF EXISTS "partners_insert" ON partners;
CREATE POLICY "partners_insert" ON partners
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- partner_distributions
DROP POLICY IF EXISTS "partner_distributions_insert" ON partner_distributions;
CREATE POLICY "partner_distributions_insert" ON partner_distributions
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- liquidity_movements
DROP POLICY IF EXISTS "liquidity_movements_insert" ON liquidity_movements;
CREATE POLICY "liquidity_movements_insert" ON liquidity_movements
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- investments
DROP POLICY IF EXISTS "investments_insert" ON investments;
CREATE POLICY "investments_insert" ON investments
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- commercial_profiles
DROP POLICY IF EXISTS "commercial_profiles_insert" ON commercial_profiles;
CREATE POLICY "commercial_profiles_insert" ON commercial_profiles
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- commercial_monthly_results
DROP POLICY IF EXISTS "commercial_monthly_results_insert" ON commercial_monthly_results;
CREATE POLICY "commercial_monthly_results_insert" ON commercial_monthly_results
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- commercial_negotiations
DROP POLICY IF EXISTS "commercial_negotiations_insert" ON commercial_negotiations;
CREATE POLICY "commercial_negotiations_insert" ON commercial_negotiations
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );
