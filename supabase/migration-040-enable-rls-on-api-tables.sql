-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 040 — Enable RLS on api_* tables (defense-in-depth)
--
-- Audit (2026-05-01) flagged 4 tables in the public schema with RLS
-- disabled:
--   · api_credentials       (encrypted integration secrets per tenant)
--   · api_balance_snapshots (point-in-time balance history per provider)
--   · api_sync_log          (cron sync events per provider)
--   · api_transactions      (deposit/withdrawal history per provider)
--
-- Today every read/write of these tables happens server-side through
-- `createAdminClient()` (service role) so RLS being off doesn't actively
-- leak data. The risk is forward-looking: any future code path that uses
-- the browser/anon client (e.g. a new client-side query inadvertently
-- imported from `mutations.ts`) would have unrestricted access.
--
-- Policies follow the pattern of channel_balances (migration 022/027):
--   · SELECT scoped by `company_id IN auth_company_ids()`.
--   · NO INSERT/UPDATE/DELETE policies → these become service-role-only,
--     which matches current usage (cron + admin endpoints already use
--     `createAdminClient()`).
--   · `api_credentials` is stricter: SELECT is superadmin-only because the
--     ciphertext + key_id should never reach a browser session even for the
--     tenant's own admin. The credentials panel decrypts via /api/admin/
--     api-credentials, which uses service role.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. api_credentials ----------------------------------------------------------
ALTER TABLE public.api_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_credentials_select ON public.api_credentials;
CREATE POLICY api_credentials_select ON public.api_credentials
  FOR SELECT USING (is_superadmin());

-- No INSERT/UPDATE/DELETE policy → service role only.

-- 2. api_balance_snapshots ----------------------------------------------------
ALTER TABLE public.api_balance_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_balance_snapshots_select ON public.api_balance_snapshots;
CREATE POLICY api_balance_snapshots_select ON public.api_balance_snapshots
  FOR SELECT USING (
    company_id IN (SELECT auth_company_ids())
  );

-- No INSERT/UPDATE/DELETE policy → service role only.

-- 3. api_sync_log -------------------------------------------------------------
ALTER TABLE public.api_sync_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_sync_log_select ON public.api_sync_log;
CREATE POLICY api_sync_log_select ON public.api_sync_log
  FOR SELECT USING (
    company_id IN (SELECT auth_company_ids())
  );

-- No INSERT/UPDATE/DELETE policy → service role only.

-- 4. api_transactions ---------------------------------------------------------
ALTER TABLE public.api_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_transactions_select ON public.api_transactions;
CREATE POLICY api_transactions_select ON public.api_transactions
  FOR SELECT USING (
    company_id IN (SELECT auth_company_ids())
  );

-- No INSERT/UPDATE/DELETE policy → service role only.

-- Verification:
--   SELECT relname, relrowsecurity FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname='public' AND relname IN
--   ('api_credentials','api_balance_snapshots','api_sync_log','api_transactions');
-- All four `relrowsecurity` must be `true`.
