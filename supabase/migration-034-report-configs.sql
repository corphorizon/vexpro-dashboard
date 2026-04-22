-- =============================================================================
-- Migration 034: report_configs — per-company report settings
-- =============================================================================
--
-- Stores which sections and which cadences the automated email reports
-- should include for each company. Admins of the company edit this from
-- /finanzas/reportes (Ajuste 2); the daily/weekly/monthly cron jobs read
-- it to decide whether to send and what sections to include.
--
-- One row per company (PK is company_id). A missing row means "all
-- sections on, all cadences on" (default behaviour — matches the current
-- cron before this migration, so rollout is non-breaking).
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS report_configs (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,

  -- Sections: which report blocks to include in the email body.
  include_deposits_withdrawals boolean NOT NULL DEFAULT true,
  include_crm_users            boolean NOT NULL DEFAULT true,
  include_broker_pnl           boolean NOT NULL DEFAULT true,
  include_prop_trading         boolean NOT NULL DEFAULT true,

  -- Cadences: whether each cron should fire for this company.
  cadence_daily_enabled   boolean NOT NULL DEFAULT true,
  cadence_weekly_enabled  boolean NOT NULL DEFAULT true,
  cadence_monthly_enabled boolean NOT NULL DEFAULT true,

  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Only company members can read; only admins can write. Writes are also
-- gated server-side via verifyAdminAuth in /api/reports/config.
ALTER TABLE report_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS report_configs_select ON report_configs;
CREATE POLICY report_configs_select ON report_configs
  FOR SELECT
  USING (
    company_id IN (
      SELECT company_id FROM company_users WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS report_configs_insert ON report_configs;
CREATE POLICY report_configs_insert ON report_configs
  FOR INSERT
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS report_configs_update ON report_configs;
CREATE POLICY report_configs_update ON report_configs
  FOR UPDATE
  USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS report_configs_delete ON report_configs;
CREATE POLICY report_configs_delete ON report_configs
  FOR DELETE
  USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

COMMENT ON TABLE report_configs IS
  'Per-company settings for automated email reports. Missing row = all on.';

COMMIT;

-- =============================================================================
-- VERIFICATION
--
--   SELECT * FROM report_configs;
--   \d report_configs
-- =============================================================================
