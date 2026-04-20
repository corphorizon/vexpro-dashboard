-- =============================================================================
-- Migration 021: Platform Users (Horizon Consulting SUPERADMIN)
-- =============================================================================
--
-- PRE-REQUISITO: Kevin confirmó que se hizo backup de la base desde Supabase
-- Dashboard → Settings → Database → Backups antes de aplicar esta migración.
-- (Backup verificado 2026-04-19 antes de iniciar multi-tenant rollout.)
--
-- Arquitectura:
--   * Los superadmins viven en su propia tabla `platform_users`, FUERA del
--     modelo de `company_users`. Un superadmin no pertenece a ninguna empresa.
--   * El flag `is_superadmin()` resuelve en cualquier policy RLS.
--   * `auth_company_ids()` se amplía: si el caller es superadmin, retorna TODAS
--     las companies. Esto arregla de una sola vez todas las policies SELECT
--     que ya usan `company_id IN (SELECT auth_company_ids())`.
--   * Las policies de write (INSERT/UPDATE/DELETE) se amplían en la siguiente
--     migración 022 porque usan un patrón distinto.
--
-- Rollback: las funciones son CREATE OR REPLACE, así que la ejecución es
-- idempotente. Para revertir: DROP TABLE platform_users CASCADE; y restaurar
-- `auth_company_ids` a su versión original (ver schema.sql:429).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Tabla platform_users
-- -----------------------------------------------------------------------------
-- Un registro por cada superadmin de Horizon Consulting. Está desacoplada de
-- `company_users` porque un superadmin NO pertenece a ninguna empresa y el
-- UNIQUE (company_id, user_id) de company_users no lo admitiría.
--
-- `user_id` apunta a auth.users — el superadmin se autentica por el mismo flujo
-- de Supabase Auth que los usuarios normales, solo que después del login el
-- backend detecta que tiene fila en platform_users y lo redirige a /superadmin.

CREATE TABLE IF NOT EXISTS platform_users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  name            text NOT NULL,
  email           text NOT NULL UNIQUE,
  role            text NOT NULL DEFAULT 'superadmin'
                    CHECK (role IN ('superadmin')),
  twofa_enabled   boolean NOT NULL DEFAULT false,
  twofa_secret    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_users_user_id ON platform_users(user_id);
CREATE INDEX IF NOT EXISTS idx_platform_users_email ON platform_users(email);

COMMENT ON TABLE platform_users IS
  'Superadmins de la plataforma (Horizon Consulting). Acceso cross-tenant. NO pertenecen a ninguna empresa.';

-- Reuse the existing updated_at trigger function (defined in schema.sql:12)
DROP TRIGGER IF EXISTS set_platform_users_updated_at ON platform_users;
CREATE TRIGGER set_platform_users_updated_at
  BEFORE UPDATE ON platform_users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Helper function: is_superadmin()
-- -----------------------------------------------------------------------------
-- Retorna TRUE si el usuario autenticado actualmente existe en platform_users.
-- SECURITY DEFINER para que las policies RLS puedan leer platform_users sin
-- que el propio usuario necesite permisos directos. STABLE porque no muta.

CREATE OR REPLACE FUNCTION is_superadmin()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_users WHERE user_id = auth.uid()
  )
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

COMMENT ON FUNCTION is_superadmin() IS
  'TRUE si el usuario autenticado es superadmin de Horizon. Usar en policies RLS.';

-- -----------------------------------------------------------------------------
-- 3. RLS en platform_users
-- -----------------------------------------------------------------------------
-- Solo los propios superadmins pueden ver/modificar platform_users. Un usuario
-- normal (auth.uid() NO en platform_users) recibe vacío en SELECT y bloqueo en
-- INSERT/UPDATE/DELETE.

ALTER TABLE platform_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_users_select ON platform_users;
CREATE POLICY platform_users_select ON platform_users
  FOR SELECT USING (is_superadmin());

DROP POLICY IF EXISTS platform_users_insert ON platform_users;
CREATE POLICY platform_users_insert ON platform_users
  FOR INSERT WITH CHECK (is_superadmin());

DROP POLICY IF EXISTS platform_users_update ON platform_users;
CREATE POLICY platform_users_update ON platform_users
  FOR UPDATE USING (is_superadmin());

DROP POLICY IF EXISTS platform_users_delete ON platform_users;
CREATE POLICY platform_users_delete ON platform_users
  FOR DELETE USING (is_superadmin());

-- -----------------------------------------------------------------------------
-- 4. Ampliación de auth_company_ids() — bypass de SELECT para superadmin
-- -----------------------------------------------------------------------------
-- Antes: retornaba solo las companies del membership del usuario en company_users.
-- Ahora: si el usuario es superadmin, retorna TODAS las companies.
--
-- Esto arregla, sin tocarlas, todas las policies SELECT existentes que ya usan
-- `company_id IN (SELECT auth_company_ids())`:
--   - companies, company_users, periods
--   - deposits, withdrawals, prop_firm_sales, p2p_transfers
--   - expenses, preoperative_expenses
--   - operating_income, broker_balance, financial_status
--   - partners, partner_distributions
--   - liquidity_movements, investments
--   - employees, commercial_profiles, commercial_monthly_results, audit_logs
--   - (y las que se hayan agregado en migraciones posteriores que usen el mismo pattern)
--
-- Nota: las policies de INSERT/UPDATE/DELETE que consultan company_users
-- directamente (patrón `company_id IN (SELECT company_id FROM company_users ...)`)
-- NO quedan arregladas por este cambio — se cubren en migration-022.

CREATE OR REPLACE FUNCTION auth_company_ids() RETURNS SETOF UUID AS $$
  SELECT
    CASE
      WHEN is_superadmin() THEN (SELECT id FROM companies)
      ELSE company_id
    END
  FROM (
    SELECT company_id FROM company_users WHERE user_id = auth.uid()
    UNION
    -- Cuando es superadmin, fuerza al menos una fila para que el CASE corra
    -- y explote a todas las companies. company_users puede estar vacío para
    -- un superadmin (no tiene memberships) — este UNION garantiza la expansión.
    SELECT NULL::uuid WHERE is_superadmin()
  ) src
  WHERE company_id IS NOT NULL OR is_superadmin();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Nota técnica sobre la función anterior:
-- Reescribí `auth_company_ids()` de forma que:
--   - Usuario normal: retorna las companies de su membership (comportamiento original).
--   - Superadmin SIN memberships: el SELECT inner retorna una fila NULL, el CASE
--     la convierte a todas las companies (vía subquery), el WHERE la deja pasar
--     porque `is_superadmin()` = TRUE.
--   - Superadmin CON memberships: cada fila se expande a todas las companies;
--     el DISTINCT implícito del IN (...) del policy deduplica.
--
-- Verificación rápida (ejecutar como un superadmin):
--   SELECT COUNT(*) FROM (SELECT auth_company_ids()) t;
-- debería retornar el número total de companies.

COMMENT ON FUNCTION auth_company_ids() IS
  'Company IDs visibles para el usuario actual. Superadmin retorna todas las companies.';

COMMIT;

-- =============================================================================
-- VERIFICACIÓN POST-MIGRACIÓN (correr en SQL editor después de aplicar)
-- =============================================================================
--
-- 1. La tabla existe y está vacía:
--      SELECT count(*) FROM platform_users;   -- esperado: 0
--
-- 2. La función is_superadmin() existe:
--      SELECT is_superadmin();                 -- esperado: false (tú no eres
--                                                 superadmin aún — se crea en F2)
--
-- 3. auth_company_ids() sigue funcionando para usuarios normales:
--      -- (autenticado como un admin de VexPro FX)
--      SELECT COUNT(*) FROM (SELECT auth_company_ids()) t;
--      -- esperado: 1 (solo VexPro FX)
--
-- 4. Los datos de VexPro FX siguen intactos (smoke test):
--      SELECT name, slug FROM companies WHERE slug = 'vexprofx';
--      SELECT count(*) FROM deposits WHERE company_id = (
--        SELECT id FROM companies WHERE slug = 'vexprofx'
--      );
-- =============================================================================
