-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 041 — wallet_label on api_transactions + remove AP Markets
--                 cross-tenant data contamination
--
-- Two changes in one migration because they're both prerequisites for the
-- 2026-05-01 Movimientos fix (P1+P2+P3):
--
-- 1. ADD COLUMN wallet_label TEXT on api_transactions.
--    Existing wallet_id is uuid-shaped string (Coinsbuy returns numeric IDs
--    like "1079"). We display the human label "VexPro Main Wallet" — that
--    label belongs in the row at persist time so the Movimientos breakdown
--    page can render it without a separate JOIN to pinned_coinsbuy_wallets.
--
-- 2. DELETE the AP Markets rows from api_transactions and api_sync_log.
--    Investigation on 2026-05-01 found that EVERY Coinsbuy/FairPay/
--    UniPayment transaction was duplicated under both Vex Pro and
--    AP Markets, because runExternalApiSync iterates every active company
--    and the auth resolvers fall back to env credentials when a tenant has
--    no api_credentials row. AP Markets has no api_credentials, so the
--    cron pulled Vex Pro's data (via env) and stored it under
--    company_id = AP Markets.
--
--    Counts before this migration (2026-05-01):
--      coinsbuy-deposits      566 rows (AP Markets)  — duplicate of Vex Pro
--      coinsbuy-withdrawals   517 rows (AP Markets)
--      fairpay                137 rows (AP Markets)
--      unipayment             581 rows (AP Markets)
--      Total                ~1,801 contaminated rows
--
--    The companion code change (this PR) removes the env fallback in
--    coinsbuy/auth.ts, fairpay/auth.ts, unipayment/auth.ts so the cron
--    will SKIP companies without per-tenant credentials going forward.
--    This DELETE cleans up the historical contamination once.
--
--    Vex Pro's rows are preserved — only company_id = AP Markets is
--    targeted, scoped by the slug to avoid affecting future legitimate
--    AP Markets data when they get their own credentials.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Schema change
ALTER TABLE public.api_transactions
  ADD COLUMN IF NOT EXISTS wallet_label TEXT;

-- 2. Cleanup AP Markets cross-tenant contamination
DELETE FROM public.api_transactions
WHERE company_id = '356ada44-b7af-4983-ac84-8685dcc8c22e'
  AND provider IN ('coinsbuy-deposits', 'coinsbuy-withdrawals', 'fairpay', 'unipayment');

DELETE FROM public.api_sync_log
WHERE company_id = '356ada44-b7af-4983-ac84-8685dcc8c22e'
  AND provider IN ('coinsbuy-deposits', 'coinsbuy-withdrawals', 'fairpay', 'unipayment');

-- 3. Audit trail of the cleanup so it's traceable.
INSERT INTO public.audit_logs (company_id, user_id, user_name, action, module, details)
VALUES (
  '356ada44-b7af-4983-ac84-8685dcc8c22e',
  'system:claude-code',
  'system',
  'delete',
  'api_transactions',
  '{"reason":"cross-tenant cleanup — env fallback in cron stored Vex Pro data under AP Markets","providers":["coinsbuy-deposits","coinsbuy-withdrawals","fairpay","unipayment"],"migration":"041"}'
);

-- Verification:
--   SELECT c.name, p.provider, COUNT(*) AS rows
--   FROM api_transactions p JOIN companies c ON c.id = p.company_id
--   GROUP BY c.name, p.provider ORDER BY c.name, p.provider;
-- After migration, AP Markets should have zero rows for any of the 4 slugs.
