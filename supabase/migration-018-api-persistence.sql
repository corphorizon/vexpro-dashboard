-- Migration 018: Persist API transactions, balance snapshots, sync log
--
-- Every time the aggregator route fetches data from Coinsbuy / FairPay /
-- UniPayment, we upsert the transactions here so:
--   1. Movimientos / Resumen General can read a stable historical view
--      even when the external APIs are temporarily down.
--   2. We can see what was true at a given "synced_at" moment.
--   3. Manual entries in /upload continue to coexist in the `deposits`
--      and `withdrawals` tables — never overwritten by API data.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. api_transactions — every transaction ever seen from an API
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider         text NOT NULL,               -- coinsbuy-deposits | coinsbuy-withdrawals | fairpay | unipayment
  external_id      text NOT NULL,               -- provider-supplied id (Coinsbuy transfer id, FairPay order id, etc.)
  amount           numeric NOT NULL,            -- canonical amount we sum into totals
  fee              numeric NOT NULL DEFAULT 0,  -- commission/mdr charged by provider
  currency         text,
  status           text,                        -- provider-specific status string (Confirmed, Completed, ...)
  transaction_date timestamptz NOT NULL,        -- createdAt from provider
  wallet_id        text,                        -- coinsbuy wallet id (nullable for other providers)
  raw              jsonb,                       -- full provider payload for debugging
  synced_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_transactions_unique UNIQUE (company_id, provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_api_transactions_company_provider_date
  ON api_transactions(company_id, provider, transaction_date DESC);

-- Admin/server only — every access goes through service role.
ALTER TABLE api_transactions DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE api_transactions IS
  'All transactions ever fetched from external APIs (Coinsbuy, FairPay, UniPayment). Upsert keyed on (company, provider, external_id).';

-- ---------------------------------------------------------------------------
-- 2. api_balance_snapshots — point-in-time balance for a provider
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_balance_snapshots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider     text NOT NULL,                   -- coinsbuy | fairpay | unipayment
  wallet_id    text,                            -- coinsbuy wallet id, null for others
  balance      numeric NOT NULL,
  currency     text,
  captured_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_balance_snapshots_company_provider_time
  ON api_balance_snapshots(company_id, provider, captured_at DESC);

ALTER TABLE api_balance_snapshots DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE api_balance_snapshots IS
  'Balance readings per provider/wallet captured at sync time. Append-only history.';

-- ---------------------------------------------------------------------------
-- 3. api_sync_log — when did we last sync a provider for a given period
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_sync_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider        text NOT NULL,
  period_from     date,
  period_to       date,
  tx_count        integer NOT NULL DEFAULT 0,
  last_synced_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_sync_log_company_provider_period
  ON api_sync_log(company_id, provider, period_from, period_to, last_synced_at DESC);

ALTER TABLE api_sync_log DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE api_sync_log IS
  'Append-only log of every API fetch. Last sync per (company, provider, period) is the latest row.';

COMMIT;
