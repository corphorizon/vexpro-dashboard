-- =============================================================================
-- Migration 031: Per-tenant default Coinsbuy wallet
-- =============================================================================
--
-- Audit SEC-A5: `DEFAULT_WALLET_ID = '1079'` was hardcoded in
-- src/components/realtime-movements-banner.tsx — that's VexPro's Main
-- Wallet ID. It worked because VexPro is the only live tenant, but the
-- second a different company onboards their Movimientos dropdown would
-- default to the wrong (and inaccessible) wallet.
--
-- Fix: each tenant declares its own default wallet. Nullable because new
-- companies won't know their wallet id until after Coinsbuy onboarding.
-- When null, the UI falls back to the first wallet returned by the
-- Coinsbuy API for that tenant.
--
-- Additive + nullable → zero-risk.
-- =============================================================================

BEGIN;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS default_wallet_id text;

COMMENT ON COLUMN companies.default_wallet_id IS
  'Tenant-specific Coinsbuy wallet ID to pre-select in the Movimientos dropdown. When NULL, the UI picks the first wallet returned by the API for this tenant.';

-- ---------------------------------------------------------------------------
-- Seed VexPro with its current hardcoded default so existing behaviour is
-- preserved. Safe: targets by slug, no-op for every other tenant.
-- ---------------------------------------------------------------------------
UPDATE companies
SET default_wallet_id = '1079'
WHERE slug = 'vexprofx'
  AND default_wallet_id IS NULL;

COMMIT;

-- =============================================================================
-- VERIFICATION
-- =============================================================================
--
--   SELECT slug, default_wallet_id FROM companies ORDER BY slug;
--
-- Expected: VexPro row shows '1079', every other row shows NULL.
-- =============================================================================
