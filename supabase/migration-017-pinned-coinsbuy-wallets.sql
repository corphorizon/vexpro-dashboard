-- migration-014-pinned-coinsbuy-wallets.sql
-- Stores which Coinsbuy wallets should appear in the "Balances por Canal"
-- section. Admins pin/unpin wallets; all company users can see the selection.

CREATE TABLE IF NOT EXISTS pinned_coinsbuy_wallets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  wallet_id    TEXT NOT NULL,
  wallet_label TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, wallet_id)
);

CREATE INDEX IF NOT EXISTS idx_pinned_coinsbuy_wallets_company
  ON pinned_coinsbuy_wallets(company_id);

ALTER TABLE pinned_coinsbuy_wallets ENABLE ROW LEVEL SECURITY;

-- All company members can see pinned wallets
DROP POLICY IF EXISTS "pinned_wallets_select" ON pinned_coinsbuy_wallets;
CREATE POLICY "pinned_wallets_select" ON pinned_coinsbuy_wallets
  FOR SELECT USING (
    company_id IN (
      SELECT company_id FROM company_users WHERE user_id = auth.uid()
    )
  );

-- Only admins can insert
DROP POLICY IF EXISTS "pinned_wallets_insert" ON pinned_coinsbuy_wallets;
CREATE POLICY "pinned_wallets_insert" ON pinned_coinsbuy_wallets
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Only admins can delete
DROP POLICY IF EXISTS "pinned_wallets_delete" ON pinned_coinsbuy_wallets;
CREATE POLICY "pinned_wallets_delete" ON pinned_coinsbuy_wallets
  FOR DELETE USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );
