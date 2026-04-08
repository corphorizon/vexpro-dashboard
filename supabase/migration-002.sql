-- ================================================
-- MIGRATION 002 — Balances, Egresos Fijos, Channel Snapshots
--
-- Adds:
--   1. expenses.is_fixed              (Egreso Fijo flag)
--   2. expense_templates              (Plantillas reutilizables de egresos fijos)
--   3. channel_balances               (Snapshots diarios de balances por canal)
--
-- Run this in the Supabase SQL editor after schema.sql + migration-001.sql
-- ================================================


-- ── 1. Egreso Fijo flag on expenses ──
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS is_fixed BOOLEAN NOT NULL DEFAULT FALSE;


-- ── 2. Expense templates (plantillas para egresos fijos) ──
CREATE TABLE IF NOT EXISTS expense_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  concept     TEXT NOT NULL,
  amount      NUMERIC NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (company_id, concept)
);

CREATE INDEX IF NOT EXISTS idx_expense_templates_company_id
  ON expense_templates(company_id);

DROP TRIGGER IF EXISTS trg_expense_templates_updated_at ON expense_templates;
CREATE TRIGGER trg_expense_templates_updated_at
  BEFORE UPDATE ON expense_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE expense_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_templates_select" ON expense_templates;
CREATE POLICY "expense_templates_select" ON expense_templates
  FOR SELECT USING (
    company_id IN (SELECT auth_company_ids())
  );

DROP POLICY IF EXISTS "expense_templates_insert" ON expense_templates;
CREATE POLICY "expense_templates_insert" ON expense_templates
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','auditor')
    )
  );

DROP POLICY IF EXISTS "expense_templates_update" ON expense_templates;
CREATE POLICY "expense_templates_update" ON expense_templates
  FOR UPDATE USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','auditor')
    )
  );

DROP POLICY IF EXISTS "expense_templates_delete" ON expense_templates;
CREATE POLICY "expense_templates_delete" ON expense_templates
  FOR DELETE USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );


-- ── 3. Channel balances (Balances por Canal — snapshots diarios) ──
CREATE TABLE IF NOT EXISTS channel_balances (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  channel_key   TEXT NOT NULL,            -- e.g. 'coinsbuy', 'fairpay', 'wallet_externa', 'otros'
  amount        NUMERIC NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'api' | 'derived'
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (company_id, snapshot_date, channel_key)
);

CREATE INDEX IF NOT EXISTS idx_channel_balances_company_date
  ON channel_balances(company_id, snapshot_date);

DROP TRIGGER IF EXISTS trg_channel_balances_updated_at ON channel_balances;
CREATE TRIGGER trg_channel_balances_updated_at
  BEFORE UPDATE ON channel_balances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE channel_balances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "channel_balances_select" ON channel_balances;
CREATE POLICY "channel_balances_select" ON channel_balances
  FOR SELECT USING (
    company_id IN (SELECT auth_company_ids())
  );

DROP POLICY IF EXISTS "channel_balances_insert" ON channel_balances;
CREATE POLICY "channel_balances_insert" ON channel_balances
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','auditor')
    )
  );

DROP POLICY IF EXISTS "channel_balances_update" ON channel_balances;
CREATE POLICY "channel_balances_update" ON channel_balances
  FOR UPDATE USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin','auditor')
    )
  );

DROP POLICY IF EXISTS "channel_balances_delete" ON channel_balances;
CREATE POLICY "channel_balances_delete" ON channel_balances
  FOR DELETE USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );
