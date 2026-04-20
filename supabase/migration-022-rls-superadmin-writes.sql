-- =============================================================================
-- Migration 022: Superadmin bypass for WRITE policies (INSERT/UPDATE/DELETE)
-- =============================================================================
--
-- Pre-req: migration-021-platform-users.sql aplicada (crea `is_superadmin()`
-- y amplía `auth_company_ids()` para SELECT).
--
-- Esta migración extiende el bypass al lado de ESCRITURA. Las policies SELECT
-- ya quedaron arregladas en 021 via auth_company_ids(). Aquí:
--
--   1. Se crean 2 helpers:
--        - auth_can_edit(cid)   → rol admin/auditor en la company, O superadmin
--        - auth_can_manage(cid) → rol admin en la company, O superadmin
--   2. Para cada tabla con `company_id`, se regeneran las policies
--      INSERT / UPDATE / DELETE usando esos helpers.
--
-- Patrón uniforme post-migración:
--   INSERT WITH CHECK (auth_can_edit(company_id))
--   UPDATE USING       (auth_can_edit(company_id))
--   DELETE USING       (auth_can_manage(company_id))
--
-- Excepciones documentadas (se mantienen especiales, no se tocan):
--   * audit_logs INSERT: cualquier usuario autenticado puede escribir logs
--   * companies INSERT: sigue restringido a admins existentes (no se cambia)
--   * company_users: policy especial (el propio superadmin debe poder crear
--     memberships a cualquier company)
--   * api_credentials, api_transactions, api_balance_snapshots, api_sync_log:
--     solo accesibles via service role (RLS negado por default) — no se tocan
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Helper functions
-- -----------------------------------------------------------------------------

-- TRUE si el caller puede EDITAR datos de la empresa (admin/auditor o superadmin)
CREATE OR REPLACE FUNCTION auth_can_edit(cid UUID)
RETURNS boolean AS $$
  SELECT is_superadmin() OR EXISTS (
    SELECT 1 FROM company_users
    WHERE user_id = auth.uid()
      AND company_id = cid
      AND role IN ('admin', 'auditor')
  )
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

COMMENT ON FUNCTION auth_can_edit(UUID) IS
  'TRUE si el caller tiene rol admin/auditor en la company, o es superadmin.';

-- TRUE si el caller puede GESTIONAR datos de la empresa (solo admin o superadmin)
CREATE OR REPLACE FUNCTION auth_can_manage(cid UUID)
RETURNS boolean AS $$
  SELECT is_superadmin() OR EXISTS (
    SELECT 1 FROM company_users
    WHERE user_id = auth.uid()
      AND company_id = cid
      AND role = 'admin'
  )
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

COMMENT ON FUNCTION auth_can_manage(UUID) IS
  'TRUE si el caller tiene rol admin en la company, o es superadmin.';

-- -----------------------------------------------------------------------------
-- 2. Regenerar policies de write en cada tabla scoped por company_id
-- -----------------------------------------------------------------------------
--
-- El bloque DO itera una lista curada de tablas. Para cada una:
--   - Borra la policy de INSERT/UPDATE/DELETE si existe (por nombre convencional)
--   - Crea la nueva policy usando los helpers.
--
-- Las tablas están listadas explícitamente para que este script NO recoja por
-- error tablas especiales (audit_logs, api_*, etc).

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    -- core movement data
    'periods',
    'deposits',
    'withdrawals',
    'prop_firm_sales',
    'p2p_transfers',
    -- expenses
    'expenses',
    'preoperative_expenses',
    -- balances & income
    'operating_income',
    'broker_balance',
    'financial_status',
    -- partners
    'partners',
    'partner_distributions',
    -- modules
    'liquidity_movements',
    'investments',
    -- HR
    'employees',
    'commercial_profiles',
    'commercial_monthly_results',
    -- templates & snapshots (from later migrations)
    'expense_templates',
    'channel_balances',
    'commercial_negotiations',
    'custom_roles',
    'pinned_coinsbuy_wallets'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Drop old write policies (nombres convencionales, con y sin comillas)
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_delete', t);

    -- Create new write policies with superadmin bypass
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (auth_can_edit(company_id))',
      t || '_insert', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (auth_can_edit(company_id))',
      t || '_update', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (auth_can_manage(company_id))',
      t || '_delete', t
    );

    RAISE NOTICE 'Regenerated write policies for table %', t;
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Casos especiales — companies y company_users
-- -----------------------------------------------------------------------------
-- `companies` y `company_users` tienen policies con forma distinta (no usan
-- `company_id IN (...)` sino `id IN (...)` o filtran por user_id).
-- Aquí las regeneramos específicamente para soportar superadmin.

-- companies: superadmin puede crear/editar/desactivar cualquier empresa
DROP POLICY IF EXISTS "companies_insert" ON companies;
CREATE POLICY "companies_insert" ON companies
  FOR INSERT WITH CHECK (
    is_superadmin()
    OR EXISTS (
      SELECT 1 FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "companies_update" ON companies;
CREATE POLICY "companies_update" ON companies
  FOR UPDATE USING (
    is_superadmin()
    OR id IN (SELECT auth_company_ids())
  );

DROP POLICY IF EXISTS "companies_delete" ON companies;
CREATE POLICY "companies_delete" ON companies
  FOR DELETE USING (
    is_superadmin()
    OR id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- company_users: superadmin puede crear/editar/borrar memberships en cualquier empresa
DROP POLICY IF EXISTS "company_users_insert" ON company_users;
CREATE POLICY "company_users_insert" ON company_users
  FOR INSERT WITH CHECK (auth_can_manage(company_id));

DROP POLICY IF EXISTS "company_users_update" ON company_users;
CREATE POLICY "company_users_update" ON company_users
  FOR UPDATE USING (auth_can_manage(company_id));

DROP POLICY IF EXISTS "company_users_delete" ON company_users;
CREATE POLICY "company_users_delete" ON company_users
  FOR DELETE USING (auth_can_manage(company_id));

-- -----------------------------------------------------------------------------
-- 4. audit_logs SELECT — ampliado para superadmin
-- -----------------------------------------------------------------------------
-- El INSERT de audit_logs sigue abierto a cualquier autenticado (correcto).
-- El SELECT hoy filtra por admin/auditor; ampliamos para que superadmin vea todo.

DROP POLICY IF EXISTS "audit_logs_select" ON audit_logs;
CREATE POLICY "audit_logs_select" ON audit_logs
  FOR SELECT USING (
    is_superadmin()
    OR company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role IN ('admin', 'auditor')
    )
    OR (company_id IS NULL AND auth.uid() IS NOT NULL)
  );

COMMIT;

-- =============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- =============================================================================
--
-- 1. Las funciones helper existen:
--      SELECT auth_can_edit(gen_random_uuid());    -- esperado: false
--      SELECT auth_can_manage(gen_random_uuid());  -- esperado: false
--
-- 2. Las policies de write se regeneraron (ejecutar como superuser):
--      SELECT schemaname, tablename, policyname, cmd
--      FROM pg_policies
--      WHERE tablename IN ('deposits','expenses','partners')
--        AND cmd IN ('INSERT','UPDATE','DELETE');
--      -- esperado: 3 filas por tabla, qual debe contener 'auth_can_edit'
--      -- o 'auth_can_manage'
--
-- 3. Un usuario de VexPro sigue pudiendo INSERT deposits (después de login):
--      INSERT INTO deposits (period_id, company_id, channel, amount)
--      VALUES (
--        (SELECT id FROM periods WHERE company_id = (SELECT id FROM companies
--          WHERE slug = 'vexprofx') LIMIT 1),
--        (SELECT id FROM companies WHERE slug = 'vexprofx'),
--        'coinsbuy', 0
--      ) RETURNING id;
--      -- esperado: éxito si el user es admin/auditor de VexPro
--
-- 4. Un usuario aleatorio NO autenticado NO puede insertar:
--      -- (sin auth.uid): SET ROLE anon; INSERT ... → bloqueado por RLS
-- =============================================================================
