-- ================================================
-- FINANCIAL DASHBOARD - DATABASE SCHEMA
-- Complete schema for multi-tenant financial dashboard
-- ================================================


-- ================================================
-- 1. TRIGGER FUNCTION (no table dependencies)
-- ================================================

-- Trigger function: auto-set updated_at on row modification
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ================================================
-- 2. CORE TABLES
-- ================================================

CREATE TABLE companies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  subdomain       TEXT UNIQUE NOT NULL,
  logo_url        TEXT,
  color_primary   TEXT DEFAULT '#1E3A5F',
  color_secondary TEXT DEFAULT '#3B82F6',
  currency        TEXT DEFAULT 'USD',
  reserve_pct     NUMERIC DEFAULT 0.25,
  active_modules  TEXT[] DEFAULT '{summary,movements,expenses,liquidity,investments,partners}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE company_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  role            TEXT CHECK (role IN ('admin','socio','auditor','soporte','hr','invitado')) NOT NULL,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  allowed_modules TEXT[],
  twofa_enabled   BOOLEAN DEFAULT FALSE,
  twofa_secret    TEXT,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(company_id, user_id)
);

CREATE TABLE periods (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  year        INT NOT NULL,
  month       INT NOT NULL,
  label       TEXT,
  is_closed   BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(company_id, year, month)
);


-- ================================================
-- 3. MOVEMENT TABLES
-- ================================================

CREATE TABLE deposits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id   UUID REFERENCES periods(id) ON DELETE CASCADE,
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  channel     TEXT CHECK (channel IN ('coinsbuy','fairpay','unipayment','other')) NOT NULL,
  amount      NUMERIC NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE withdrawals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id   UUID REFERENCES periods(id) ON DELETE CASCADE,
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  category    TEXT CHECK (category IN ('ib_commissions','broker','prop_firm','other')) NOT NULL,
  amount      NUMERIC NOT NULL DEFAULT 0,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE prop_firm_sales (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id   UUID REFERENCES periods(id) ON DELETE CASCADE,
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  amount      NUMERIC NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE p2p_transfers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id   UUID REFERENCES periods(id) ON DELETE CASCADE,
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  amount      NUMERIC NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);


-- ================================================
-- 4. EXPENSE TABLES
-- ================================================

CREATE TABLE expenses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id   UUID REFERENCES periods(id) ON DELETE CASCADE,
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  concept     TEXT NOT NULL,
  amount      NUMERIC NOT NULL,
  paid        NUMERIC DEFAULT 0,
  pending     NUMERIC DEFAULT 0,
  category    TEXT,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE preoperative_expenses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  concept     TEXT NOT NULL,
  amount      NUMERIC NOT NULL,
  paid        NUMERIC DEFAULT 0,
  pending     NUMERIC DEFAULT 0,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);


-- ================================================
-- 5. INCOME / BALANCE / STATUS TABLES
-- ================================================

CREATE TABLE operating_income (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id       UUID REFERENCES periods(id) ON DELETE CASCADE,
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
  prop_firm       NUMERIC DEFAULT 0,
  broker_pnl      NUMERIC DEFAULT 0,
  other           NUMERIC DEFAULT 0,
  reserve_amount  NUMERIC DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(company_id, period_id)
);

CREATE TABLE broker_balance (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id             UUID REFERENCES periods(id) ON DELETE CASCADE,
  company_id            UUID REFERENCES companies(id) ON DELETE CASCADE,
  pnl_book_b            NUMERIC DEFAULT 0,
  liquidity_commissions NUMERIC DEFAULT 0,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now(),
  UNIQUE(company_id, period_id)
);

CREATE TABLE financial_status (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id               UUID REFERENCES periods(id) ON DELETE CASCADE,
  company_id              UUID REFERENCES companies(id) ON DELETE CASCADE,
  accumulated_reserve     NUMERIC DEFAULT 0,
  current_month_reserve   NUMERIC DEFAULT 0,
  operating_expenses_paid NUMERIC DEFAULT 0,
  net_total               NUMERIC DEFAULT 0,
  previous_month_balance  NUMERIC DEFAULT 0,
  current_month_balance   NUMERIC DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now(),
  UNIQUE(company_id, period_id)
);


-- ================================================
-- 6. PARTNERS TABLES
-- ================================================

CREATE TABLE partners (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES auth.users(id),
  name        TEXT NOT NULL,
  email       TEXT,
  percentage  NUMERIC NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE partner_distributions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id   UUID REFERENCES periods(id) ON DELETE CASCADE,
  partner_id  UUID REFERENCES partners(id) ON DELETE CASCADE,
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  percentage  NUMERIC NOT NULL,
  amount      NUMERIC NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);


-- ================================================
-- 7. LIQUIDITY & INVESTMENTS
-- ================================================

CREATE TABLE liquidity_movements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  user_email  TEXT,
  mt_account  TEXT,
  deposit     NUMERIC DEFAULT 0,
  withdrawal  NUMERIC DEFAULT 0,
  balance     NUMERIC DEFAULT 0,
  notes       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE investments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  concept     TEXT,
  responsible TEXT,
  deposit     NUMERIC DEFAULT 0,
  withdrawal  NUMERIC DEFAULT 0,
  profit      NUMERIC DEFAULT 0,
  balance     NUMERIC DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);


-- ================================================
-- 8. HR TABLES
-- ================================================

CREATE TABLE employees (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  position    TEXT,
  department  TEXT,
  start_date  DATE,
  salary      NUMERIC,
  status      TEXT CHECK (status IN ('active','inactive','probation')) DEFAULT 'active',
  phone       TEXT,
  country     TEXT,
  notes       TEXT,
  birthday    DATE,
  supervisor  TEXT,
  comments    TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE commercial_profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID REFERENCES companies(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  email               TEXT NOT NULL,
  role                TEXT CHECK (role IN ('sales_manager','head','bdm')) NOT NULL,
  head_id             UUID REFERENCES commercial_profiles(id),
  net_deposit_pct     NUMERIC,
  pnl_pct             NUMERIC,
  commission_per_lot  NUMERIC,
  salary              NUMERIC,
  benefits            TEXT,
  comments            TEXT,
  hire_date           DATE,
  birthday            DATE,
  status              TEXT CHECK (status IN ('active','inactive')) DEFAULT 'active',
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE commercial_monthly_results (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id              UUID REFERENCES commercial_profiles(id) ON DELETE CASCADE,
  period_id               UUID REFERENCES periods(id) ON DELETE CASCADE,
  company_id              UUID REFERENCES companies(id) ON DELETE CASCADE,
  net_deposit_current     NUMERIC DEFAULT 0,
  net_deposit_accumulated NUMERIC DEFAULT 0,
  net_deposit_total       NUMERIC DEFAULT 0,
  pnl_current             NUMERIC DEFAULT 0,
  pnl_accumulated         NUMERIC DEFAULT 0,
  pnl_total               NUMERIC DEFAULT 0,
  commissions_earned      NUMERIC DEFAULT 0,
  bonus                   NUMERIC DEFAULT 0,
  salary_paid             NUMERIC DEFAULT 0,
  total_earned            NUMERIC DEFAULT 0,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now(),
  UNIQUE(profile_id, period_id)
);


-- ================================================
-- 9. AUDIT LOGS
-- ================================================

CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  user_id     TEXT,
  user_name   TEXT,
  action      TEXT CHECK (action IN ('create','update','delete','login','logout','export','view')) NOT NULL,
  module      TEXT NOT NULL,
  details     TEXT,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);


-- ================================================
-- 10. TRIGGERS (updated_at)
-- ================================================

CREATE TRIGGER trg_companies_updated_at BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_company_users_updated_at BEFORE UPDATE ON company_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_periods_updated_at BEFORE UPDATE ON periods FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_deposits_updated_at BEFORE UPDATE ON deposits FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_withdrawals_updated_at BEFORE UPDATE ON withdrawals FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_prop_firm_sales_updated_at BEFORE UPDATE ON prop_firm_sales FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_p2p_transfers_updated_at BEFORE UPDATE ON p2p_transfers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_expenses_updated_at BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_preoperative_expenses_updated_at BEFORE UPDATE ON preoperative_expenses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_operating_income_updated_at BEFORE UPDATE ON operating_income FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_broker_balance_updated_at BEFORE UPDATE ON broker_balance FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_financial_status_updated_at BEFORE UPDATE ON financial_status FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_partners_updated_at BEFORE UPDATE ON partners FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_partner_distributions_updated_at BEFORE UPDATE ON partner_distributions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_liquidity_movements_updated_at BEFORE UPDATE ON liquidity_movements FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_investments_updated_at BEFORE UPDATE ON investments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_employees_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_commercial_profiles_updated_at BEFORE UPDATE ON commercial_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_commercial_monthly_results_updated_at BEFORE UPDATE ON commercial_monthly_results FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ================================================
-- 11. INDEXES
-- ================================================

-- company_id indexes
CREATE INDEX idx_company_users_company_id ON company_users(company_id);
CREATE INDEX idx_periods_company_id ON periods(company_id);
CREATE INDEX idx_deposits_company_id ON deposits(company_id);
CREATE INDEX idx_withdrawals_company_id ON withdrawals(company_id);
CREATE INDEX idx_prop_firm_sales_company_id ON prop_firm_sales(company_id);
CREATE INDEX idx_p2p_transfers_company_id ON p2p_transfers(company_id);
CREATE INDEX idx_expenses_company_id ON expenses(company_id);
CREATE INDEX idx_preoperative_expenses_company_id ON preoperative_expenses(company_id);
CREATE INDEX idx_operating_income_company_id ON operating_income(company_id);
CREATE INDEX idx_broker_balance_company_id ON broker_balance(company_id);
CREATE INDEX idx_financial_status_company_id ON financial_status(company_id);
CREATE INDEX idx_partners_company_id ON partners(company_id);
CREATE INDEX idx_partner_distributions_company_id ON partner_distributions(company_id);
CREATE INDEX idx_liquidity_movements_company_id ON liquidity_movements(company_id);
CREATE INDEX idx_investments_company_id ON investments(company_id);
CREATE INDEX idx_employees_company_id ON employees(company_id);
CREATE INDEX idx_commercial_profiles_company_id ON commercial_profiles(company_id);
CREATE INDEX idx_commercial_monthly_results_company_id ON commercial_monthly_results(company_id);
CREATE INDEX idx_audit_logs_company_id ON audit_logs(company_id);

-- period_id indexes
CREATE INDEX idx_deposits_period_id ON deposits(period_id);
CREATE INDEX idx_withdrawals_period_id ON withdrawals(period_id);
CREATE INDEX idx_prop_firm_sales_period_id ON prop_firm_sales(period_id);
CREATE INDEX idx_p2p_transfers_period_id ON p2p_transfers(period_id);
CREATE INDEX idx_expenses_period_id ON expenses(period_id);
CREATE INDEX idx_operating_income_period_id ON operating_income(period_id);
CREATE INDEX idx_broker_balance_period_id ON broker_balance(period_id);
CREATE INDEX idx_financial_status_period_id ON financial_status(period_id);
CREATE INDEX idx_partner_distributions_period_id ON partner_distributions(period_id);
CREATE INDEX idx_commercial_monthly_results_period_id ON commercial_monthly_results(period_id);

-- Composite (company_id, period_id) on period-scoped tables
CREATE INDEX idx_deposits_company_period ON deposits(company_id, period_id);
CREATE INDEX idx_withdrawals_company_period ON withdrawals(company_id, period_id);
CREATE INDEX idx_prop_firm_sales_company_period ON prop_firm_sales(company_id, period_id);
CREATE INDEX idx_p2p_transfers_company_period ON p2p_transfers(company_id, period_id);
CREATE INDEX idx_expenses_company_period ON expenses(company_id, period_id);
CREATE INDEX idx_operating_income_company_period ON operating_income(company_id, period_id);
CREATE INDEX idx_broker_balance_company_period ON broker_balance(company_id, period_id);
CREATE INDEX idx_financial_status_company_period ON financial_status(company_id, period_id);
CREATE INDEX idx_partner_distributions_company_period ON partner_distributions(company_id, period_id);
CREATE INDEX idx_commercial_monthly_results_company_period ON commercial_monthly_results(company_id, period_id);

-- Audit logs indexes
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_company_module ON audit_logs(company_id, module);

-- Commercial indexes
CREATE INDEX idx_commercial_profiles_head_id ON commercial_profiles(head_id);
CREATE INDEX idx_commercial_monthly_results_profile_period ON commercial_monthly_results(profile_id, period_id);

-- company_users user_id for auth lookups
CREATE INDEX idx_company_users_user_id ON company_users(user_id);


-- ================================================
-- 12. HELPER FUNCTIONS (depend on tables)
-- ================================================

-- Helper: returns company_ids the current user belongs to
CREATE OR REPLACE FUNCTION auth_company_ids() RETURNS SETOF UUID AS $$
  SELECT company_id FROM company_users WHERE user_id = auth.uid()
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Helper: returns the role for the current user in a given company
CREATE OR REPLACE FUNCTION auth_user_role(p_company_id UUID) RETURNS TEXT AS $$
  SELECT role FROM company_users WHERE user_id = auth.uid() AND company_id = p_company_id LIMIT 1
$$ LANGUAGE SQL SECURITY DEFINER STABLE;


-- ================================================
-- 13. ROW LEVEL SECURITY
-- ================================================

-- Enable RLS on all tables
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE prop_firm_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE p2p_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE preoperative_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE operating_income ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_distributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE liquidity_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_monthly_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------
-- companies
-- ----------------------------------------
CREATE POLICY "companies_select" ON companies
  FOR SELECT USING (id IN (SELECT auth_company_ids()));

CREATE POLICY "companies_insert" ON companies
  FOR INSERT WITH CHECK (TRUE); -- new company creation allowed (user joins via company_users)

CREATE POLICY "companies_update" ON companies
  FOR UPDATE USING (
    id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "companies_delete" ON companies
  FOR DELETE USING (
    id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ----------------------------------------
-- company_users
-- ----------------------------------------
CREATE POLICY "company_users_select" ON company_users
  FOR SELECT USING (company_id IN (SELECT auth_company_ids()));

CREATE POLICY "company_users_insert" ON company_users
  FOR INSERT WITH CHECK (
    company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "company_users_update" ON company_users
  FOR UPDATE USING (
    company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "company_users_delete" ON company_users
  FOR DELETE USING (
    company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ----------------------------------------
-- periods
-- ----------------------------------------
CREATE POLICY "periods_select" ON periods
  FOR SELECT USING (company_id IN (SELECT auth_company_ids()));

CREATE POLICY "periods_insert" ON periods
  FOR INSERT WITH CHECK (
    company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor'))
  );

CREATE POLICY "periods_update" ON periods
  FOR UPDATE USING (
    company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor'))
  );

CREATE POLICY "periods_delete" ON periods
  FOR DELETE USING (
    company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ----------------------------------------
-- Standard data tables: SELECT for all members, INSERT/UPDATE for admin+auditor, DELETE for admin
-- Applied to: deposits, withdrawals, prop_firm_sales, p2p_transfers,
--             expenses, preoperative_expenses, operating_income, broker_balance,
--             financial_status, liquidity_movements, investments,
--             employees, commercial_profiles, commercial_monthly_results
-- ----------------------------------------

-- deposits
CREATE POLICY "deposits_select" ON deposits FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "deposits_insert" ON deposits FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "deposits_update" ON deposits FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "deposits_delete" ON deposits FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- withdrawals
CREATE POLICY "withdrawals_select" ON withdrawals FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "withdrawals_insert" ON withdrawals FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "withdrawals_update" ON withdrawals FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "withdrawals_delete" ON withdrawals FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- prop_firm_sales
CREATE POLICY "prop_firm_sales_select" ON prop_firm_sales FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "prop_firm_sales_insert" ON prop_firm_sales FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "prop_firm_sales_update" ON prop_firm_sales FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "prop_firm_sales_delete" ON prop_firm_sales FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- p2p_transfers
CREATE POLICY "p2p_transfers_select" ON p2p_transfers FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "p2p_transfers_insert" ON p2p_transfers FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "p2p_transfers_update" ON p2p_transfers FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "p2p_transfers_delete" ON p2p_transfers FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- expenses
CREATE POLICY "expenses_select" ON expenses FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "expenses_insert" ON expenses FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "expenses_update" ON expenses FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "expenses_delete" ON expenses FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- preoperative_expenses
CREATE POLICY "preoperative_expenses_select" ON preoperative_expenses FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "preoperative_expenses_insert" ON preoperative_expenses FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "preoperative_expenses_update" ON preoperative_expenses FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "preoperative_expenses_delete" ON preoperative_expenses FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- operating_income
CREATE POLICY "operating_income_select" ON operating_income FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "operating_income_insert" ON operating_income FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "operating_income_update" ON operating_income FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "operating_income_delete" ON operating_income FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- broker_balance
CREATE POLICY "broker_balance_select" ON broker_balance FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "broker_balance_insert" ON broker_balance FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "broker_balance_update" ON broker_balance FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "broker_balance_delete" ON broker_balance FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- financial_status
CREATE POLICY "financial_status_select" ON financial_status FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "financial_status_insert" ON financial_status FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "financial_status_update" ON financial_status FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "financial_status_delete" ON financial_status FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- liquidity_movements
CREATE POLICY "liquidity_movements_select" ON liquidity_movements FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "liquidity_movements_insert" ON liquidity_movements FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "liquidity_movements_update" ON liquidity_movements FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "liquidity_movements_delete" ON liquidity_movements FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- investments
CREATE POLICY "investments_select" ON investments FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "investments_insert" ON investments FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "investments_update" ON investments FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "investments_delete" ON investments FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- employees
CREATE POLICY "employees_select" ON employees FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "employees_insert" ON employees FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "employees_update" ON employees FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "employees_delete" ON employees FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- commercial_profiles
CREATE POLICY "commercial_profiles_select" ON commercial_profiles FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "commercial_profiles_insert" ON commercial_profiles FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "commercial_profiles_update" ON commercial_profiles FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "commercial_profiles_delete" ON commercial_profiles FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- commercial_monthly_results
CREATE POLICY "commercial_monthly_results_select" ON commercial_monthly_results FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "commercial_monthly_results_insert" ON commercial_monthly_results FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "commercial_monthly_results_update" ON commercial_monthly_results FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "commercial_monthly_results_delete" ON commercial_monthly_results FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- ----------------------------------------
-- partners: all members can see partners list
-- ----------------------------------------
CREATE POLICY "partners_select" ON partners FOR SELECT USING (company_id IN (SELECT auth_company_ids()));
CREATE POLICY "partners_insert" ON partners FOR INSERT WITH CHECK (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "partners_update" ON partners FOR UPDATE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor')));
CREATE POLICY "partners_delete" ON partners FOR DELETE USING (company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'));

-- ----------------------------------------
-- partner_distributions: socios see only their own; admin/auditor see all
-- ----------------------------------------
CREATE POLICY "partner_distributions_select" ON partner_distributions
  FOR SELECT USING (
    partner_id IN (SELECT id FROM partners WHERE user_id = auth.uid())
    OR company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor'))
  );

CREATE POLICY "partner_distributions_insert" ON partner_distributions
  FOR INSERT WITH CHECK (
    company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor'))
  );

CREATE POLICY "partner_distributions_update" ON partner_distributions
  FOR UPDATE USING (
    company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor'))
  );

CREATE POLICY "partner_distributions_delete" ON partner_distributions
  FOR DELETE USING (
    company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ----------------------------------------
-- audit_logs: SELECT for admin/auditor only, INSERT for any authenticated user
-- ----------------------------------------
CREATE POLICY "audit_logs_select" ON audit_logs
  FOR SELECT USING (
    company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role IN ('admin','auditor'))
    OR (company_id IS NULL AND auth.uid() IS NOT NULL)
  );

CREATE POLICY "audit_logs_insert" ON audit_logs
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
