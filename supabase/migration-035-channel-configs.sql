-- =============================================================================
-- Migration 035: channel_configs — per-company Balances por Canal settings
-- =============================================================================
-- One row per (company, channel_key). Rows for the 7 built-in channels are
-- created lazily the first time the admin toggles/edits them. Custom
-- channels created by the user get channel_key = 'custom_<uuid>' with
-- is_custom = true (only those can be deleted).
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS channel_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel_key text NOT NULL,
  custom_label text,
  channel_type text NOT NULL DEFAULT 'manual' CHECK (channel_type IN ('api', 'manual', 'auto')),
  is_visible boolean NOT NULL DEFAULT true,
  is_custom boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_configs_unique UNIQUE (company_id, channel_key)
);

CREATE INDEX IF NOT EXISTS idx_channel_configs_company ON channel_configs(company_id);

ALTER TABLE channel_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_configs_select ON channel_configs;
CREATE POLICY channel_configs_select ON channel_configs
  FOR SELECT
  USING (
    company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS channel_configs_insert ON channel_configs;
CREATE POLICY channel_configs_insert ON channel_configs
  FOR INSERT
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS channel_configs_update ON channel_configs;
CREATE POLICY channel_configs_update ON channel_configs
  FOR UPDATE
  USING (
    company_id IN (
      SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS channel_configs_delete ON channel_configs;
CREATE POLICY channel_configs_delete ON channel_configs
  FOR DELETE
  USING (
    company_id IN (
      SELECT company_id FROM company_users WHERE user_id = auth.uid() AND role = 'admin'
    ) AND is_custom = true
  );

COMMENT ON TABLE channel_configs IS 'Per-company toggle/rename/custom channel settings for the Balances por Canal card.';

COMMIT;
