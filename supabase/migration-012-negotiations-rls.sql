-- migration-012-negotiations-rls.sql
-- Add RLS policies for commercial_negotiations table
-- (RLS was enabled in migration-010 but no policies were created)

-- SELECT: any user in the company can read
CREATE POLICY "commercial_negotiations_select" ON commercial_negotiations
  FOR SELECT USING (company_id IN (SELECT auth_company_ids()));

-- INSERT: admin, auditor, hr can create
CREATE POLICY "commercial_negotiations_insert" ON commercial_negotiations
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- UPDATE: admin, auditor, hr can update
CREATE POLICY "commercial_negotiations_update" ON commercial_negotiations
  FOR UPDATE USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','auditor','hr'])
    )
  );

-- DELETE: admin, hr only
CREATE POLICY "commercial_negotiations_delete" ON commercial_negotiations
  FOR DELETE USING (
    company_id IN (
      SELECT company_id FROM company_users
      WHERE user_id = auth.uid() AND role = ANY(ARRAY['admin','hr'])
    )
  );
