-- =============================================================================
-- Migration 074: bypass de superadmin en income_lines / business_units /
--                location_business_units
-- =============================================================================
--
-- Pre-req: migration-021-platform-users.sql (crea `is_superadmin()`) y
-- migration-022-rls-superadmin-writes.sql (fija el patrón que se replica acá).
--
-- QUÉ PASA HOY
-- ------------
-- Las tres tablas nacieron en 068/070/071 con policies escritas a mano:
--
--     using (company_id in (select company_id from company_users
--                           where user_id = auth.uid()))
--
-- Ese predicado pregunta por una FILA EN company_users. El superadmin de
-- plataforma no tiene ninguna: vive en `platform_users` y opera los tenants en
-- modo "viendo como". Para él la subconsulta devuelve el conjunto vacío, así
-- que la policy no falla ni tira 403 — devuelve CERO FILAS. Es el modo de
-- fallo peor posible: la pantalla carga, no hay error, y los ingresos /
-- unidades de negocio / asignaciones simplemente no existen.
--
-- POR QUÉ NO SE NOTA
-- ------------------
-- Porque hoy TODAS las lecturas de estas tablas pasan por el service role
-- (`createAdminClient()` en /api/admin/income-lines, /business-units y
-- /location-units), que saltea RLS por completo. La RLS rota queda tapada por
-- el cliente que se usa, no por estar bien.
--
-- Eso convierte la elección de cliente en un requisito de seguridad implícito:
-- el día que alguien lea estas tablas desde el cliente anon —un componente
-- server con la sesión del usuario, un realtime, un RPC nuevo— el superadmin
-- va a ver una empresa vacía y nadie va a entender por qué. Es exactamente el
-- bug que Kevin reportó en Balances con `role === 'admin'`, pero en SQL.
--
-- QUÉ HACE ESTA MIGRACIÓN
-- -----------------------
-- Regenera las 6 policies con el patrón uniforme de 022+:
--
--   SELECT → is_superadmin() OR <membresía en la empresa>
--   ALL    → auth_can_edit(company_id)   (admin/auditor en la empresa, O superadmin)
--
-- `auth_can_edit()` ya existe desde 022 y encapsula justamente el
-- "admin/auditor o superadmin" que estas tablas escribieron a mano.
--
-- No amplía el acceso de ningún usuario normal: el predicado de membresía es
-- idéntico al anterior. Lo único que cambia es que el superadmin deja de ser
-- un fantasma sin filas.
-- =============================================================================

BEGIN;

-- ── income_lines (068) ──────────────────────────────────────────────────────
drop policy if exists income_lines_select on public.income_lines;
create policy income_lines_select on public.income_lines
  for select using (
    is_superadmin()
    or company_id in (
      select company_id from public.company_users where user_id = (select auth.uid())
    )
  );

drop policy if exists income_lines_write on public.income_lines;
create policy income_lines_write on public.income_lines
  for all using (auth_can_edit(company_id));

-- ── business_units (070) ────────────────────────────────────────────────────
drop policy if exists business_units_select on public.business_units;
create policy business_units_select on public.business_units
  for select using (
    is_superadmin()
    or company_id in (
      select company_id from public.company_users where user_id = (select auth.uid())
    )
  );

drop policy if exists business_units_write on public.business_units;
create policy business_units_write on public.business_units
  for all using (auth_can_edit(company_id));

-- ── location_business_units (071) ───────────────────────────────────────────
drop policy if exists lbu_select on public.location_business_units;
create policy lbu_select on public.location_business_units
  for select using (
    is_superadmin()
    or company_id in (
      select company_id from public.company_users where user_id = (select auth.uid())
    )
  );

drop policy if exists lbu_write on public.location_business_units;
create policy lbu_write on public.location_business_units
  for all using (auth_can_edit(company_id));

COMMIT;

-- =============================================================================
-- Verificación (correr después de aplicar)
-- =============================================================================
-- select tablename, policyname, qual
--   from pg_policies
--  where schemaname = 'public'
--    and tablename in ('income_lines', 'business_units', 'location_business_units')
--  order by tablename, policyname;
--
-- Las 3 policies de select deben mencionar `is_superadmin()` y las 3 de write
-- deben ser `auth_can_edit(company_id)`.
-- =============================================================================
