-- =============================================================================
-- Migration 033: Add 'orion_crm' to api_credentials.provider CHECK
-- =============================================================================
--
-- The existing CHECK was created inline on the CREATE TABLE statement
-- (migration-016) with an anonymous constraint name. We don't know the
-- generated name ahead of time so we look it up at runtime and drop it
-- cleanly before re-adding the expanded list.
--
-- New allowed value:
--   'orion_crm' → the CRM that exposes prop firm sales, broker P&L,
--                  purchases, and registered users. Per-tenant credentials
--                  so each company points at its own CRM instance.
--
-- Existing values kept untouched:
--   sendgrid, coinsbuy, unipayment, fairpay
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_constraint_name text;
BEGIN
  SELECT conname INTO v_constraint_name
  FROM pg_constraint
  WHERE conrelid = 'api_credentials'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%provider%IN%';

  IF v_constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE api_credentials DROP CONSTRAINT %I', v_constraint_name);
    RAISE NOTICE 'Dropped old provider CHECK (%)', v_constraint_name;
  END IF;
END $$;

ALTER TABLE api_credentials
  ADD CONSTRAINT api_credentials_provider_check
  CHECK (provider IN ('sendgrid', 'coinsbuy', 'unipayment', 'fairpay', 'orion_crm'));

COMMIT;

-- =============================================================================
-- VERIFICATION
--
--   SELECT pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'api_credentials'::regclass AND conname = 'api_credentials_provider_check';
--
-- Expected: CHECK(... IN ('sendgrid', 'coinsbuy', 'unipayment', 'fairpay', 'orion_crm'))
-- =============================================================================
