-- Migration 016: Settings module — custom roles + API credentials per company
--
-- 1. custom_roles: per-company role definitions with a base_role that drives
--    canEdit/canDelete permissions, plus a default module set.
--
-- 2. api_credentials: encrypted provider credentials (SendGrid, Coinsbuy,
--    Unipayment, Fairpay). The secret column holds an AES-256-GCM ciphertext,
--    iv and auth_tag are stored separately. Only the service role can access
--    these rows.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. custom_roles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  base_role text NOT NULL CHECK (base_role IN ('admin', 'socio', 'auditor', 'soporte', 'hr', 'invitado')),
  default_modules text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT custom_roles_name_unique UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_custom_roles_company ON custom_roles(company_id);

ALTER TABLE custom_roles ENABLE ROW LEVEL SECURITY;

-- All authenticated company members can read roles of their company
DROP POLICY IF EXISTS custom_roles_select ON custom_roles;
CREATE POLICY custom_roles_select ON custom_roles
  FOR SELECT
  USING (
    company_id IN (
      SELECT company_id FROM company_users WHERE user_id = auth.uid()
    )
  );

-- Only admins can INSERT/UPDATE/DELETE — enforced server-side via admin client.
-- We still add RLS INSERT policy as defense in depth.
DROP POLICY IF EXISTS custom_roles_insert ON custom_roles;
CREATE POLICY custom_roles_insert ON custom_roles
  FOR INSERT
  WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS custom_roles_update ON custom_roles;
CREATE POLICY custom_roles_update ON custom_roles
  FOR UPDATE
  USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS custom_roles_delete ON custom_roles;
CREATE POLICY custom_roles_delete ON custom_roles
  FOR DELETE
  USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

COMMENT ON TABLE custom_roles IS
  'Per-company custom role definitions. base_role determines capability tier (admin/auditor/etc).';

-- ---------------------------------------------------------------------------
-- 2. api_credentials
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('sendgrid', 'coinsbuy', 'unipayment', 'fairpay')),
  encrypted_secret text NOT NULL,         -- base64 ciphertext
  iv text NOT NULL,                       -- base64 IV
  auth_tag text NOT NULL,                 -- base64 auth tag (GCM)
  extra_config jsonb,                     -- non-sensitive: from_email, webhook_url, etc.
  last_four text,                         -- last 4 chars of the original secret, for display
  is_configured boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT api_credentials_unique UNIQUE (company_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_api_credentials_company ON api_credentials(company_id);

-- API credentials are admin-only. RLS is disabled because only the service
-- role (admin client) should touch this table. Every access is gated by
-- verifyAdminAuth in the corresponding /api/admin route.
ALTER TABLE api_credentials DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE api_credentials IS
  'Per-company encrypted provider credentials. Only accessed via service role + admin-auth gated endpoints.';
COMMENT ON COLUMN api_credentials.encrypted_secret IS
  'AES-256-GCM ciphertext of the API secret, base64-encoded.';
COMMENT ON COLUMN api_credentials.last_four IS
  'Last 4 chars of the plaintext secret for display only (e.g. "••••u-Q").';

COMMIT;
