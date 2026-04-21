-- =============================================================================
-- Migration 026: channel_balances_as_of(company, date) RPC
-- =============================================================================
--
-- Bug we are fixing:
--   Manual channels (FairPay, Wallet Externa, Otros) only had rows on the
--   exact day the user typed a value. The /balances page's
--   `fetchChannelBalances(company, date)` did `.eq('snapshot_date', date)`,
--   so on any later day with no edit those channels showed $0.
--
-- New behaviour:
--   For a given (company, date), return the LATEST row per channel where
--   snapshot_date <= date. This means:
--     · A manual edit on day D persists through D+1, D+2 … until the next
--       edit (or until a different source writes a newer row).
--   · Asking for an older date returns the value that was in effect on
--     that date — true historical timeline.
--
-- Implemented as a SQL function so the heavy lifting (DISTINCT ON) runs in
-- Postgres. SECURITY INVOKER so existing RLS policies on channel_balances
-- still apply (a tenant only sees its own rows).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION channel_balances_as_of(
  p_company_id UUID,
  p_date       DATE
)
RETURNS SETOF channel_balances
LANGUAGE SQL
STABLE
SECURITY INVOKER
AS $$
  SELECT DISTINCT ON (channel_key) *
  FROM channel_balances
  WHERE company_id = p_company_id
    AND snapshot_date <= p_date
  ORDER BY channel_key, snapshot_date DESC, updated_at DESC;
$$;

COMMENT ON FUNCTION channel_balances_as_of(UUID, DATE) IS
  'Returns the most recent channel_balances row per channel_key with snapshot_date <= p_date. Used by the /balances UI so manual entries persist forward until edited.';

-- Index that makes the DISTINCT ON cheap. Already partially covered by
-- idx_channel_balances_company_date; we add channel_key + DESC date to
-- avoid a sort step.
CREATE INDEX IF NOT EXISTS idx_channel_balances_company_channel_date
  ON channel_balances(company_id, channel_key, snapshot_date DESC);

COMMIT;

-- =============================================================================
-- VERIFICATION
-- =============================================================================
--
-- 1. Function exists and runs:
--      SELECT channel_key, snapshot_date, amount, source
--      FROM channel_balances_as_of(
--        (SELECT id FROM companies WHERE slug = 'vexprofx'),
--        CURRENT_DATE
--      );
--    Expect: one row per channel_key the tenant has ever had.
--
-- 2. Asking a future date returns the same as today (no rows after today).
-- 3. Asking yesterday returns rows that existed at end-of-yesterday.
-- =============================================================================
