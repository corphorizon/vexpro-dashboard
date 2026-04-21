-- =============================================================================
-- Migration 032: Drop vexprofx.com from the VexPro subdomain row
-- =============================================================================
--
-- The `companies.subdomain` of VexPro was set to 'dashboard.vexprofx.com'
-- back when the plan was to serve each tenant from its own Vex-branded
-- subdomain. That plan was replaced by a single platform domain
-- (dashboard.horizonconsulting.ai) — `subdomain` is no longer used in any
-- runtime code path, but keeping a `.vexprofx.com` value leaks tenant
-- branding at the platform level and shows up in DB exports.
--
-- Rename to the slug-only convention that AP Markets already follows:
--   AP Markets.subdomain = 'ap-markets'
--   VexPro.subdomain     = 'vexprofx'  (was 'dashboard.vexprofx.com')
--
-- The email addresses of VexPro employees in `company_users`
-- (@vexprofx.com) are left untouched — those are real corporate
-- addresses of the tenant's users, not platform-level references.
-- =============================================================================

BEGIN;

UPDATE companies
SET subdomain = 'vexprofx',
    updated_at = now()
WHERE slug = 'vexprofx'
  AND subdomain LIKE '%vexprofx.com%';

COMMIT;

-- =============================================================================
-- VERIFICATION
--
--   SELECT slug, subdomain FROM companies ORDER BY slug;
--
-- Expected:
--   ap-markets  ap-markets
--   vexprofx    vexprofx
-- =============================================================================
