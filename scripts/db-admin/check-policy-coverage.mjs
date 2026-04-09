// Verifies, for every table in public, whether it has company-scoped policies
// (name matching <table>_select / _insert / _update / _delete) so we can
// safely drop the legacy "Allow public read access" / "Allow authenticated *"
// policies without leaving a table wide open.
import { withClient } from './_client.mjs';

await withClient(async (c) => {
  const { rows } = await c.query(`
    WITH all_tables AS (
      SELECT cls.relname AS table
      FROM pg_class cls
      JOIN pg_namespace n ON n.oid = cls.relnamespace
      WHERE cls.relkind = 'r' AND n.nspname = 'public'
    ),
    pol AS (
      SELECT tablename, cmd, policyname, qual, with_check
      FROM pg_policies
      WHERE schemaname = 'public'
    )
    SELECT
      t.table,
      (SELECT count(*) FROM pol p WHERE p.tablename = t.table AND p.cmd = 'SELECT'
         AND p.qual != 'true') AS select_safe,
      (SELECT count(*) FROM pol p WHERE p.tablename = t.table AND p.cmd = 'SELECT'
         AND p.qual = 'true') AS select_open,
      (SELECT count(*) FROM pol p WHERE p.tablename = t.table AND p.cmd = 'INSERT'
         AND p.with_check != 'true') AS insert_safe,
      (SELECT count(*) FROM pol p WHERE p.tablename = t.table AND p.cmd = 'INSERT'
         AND p.with_check = 'true') AS insert_open,
      (SELECT count(*) FROM pol p WHERE p.tablename = t.table AND p.cmd = 'UPDATE'
         AND (p.qual != 'true' OR p.qual IS NULL)) AS update_safe,
      (SELECT count(*) FROM pol p WHERE p.tablename = t.table AND p.cmd = 'UPDATE'
         AND p.qual = 'true') AS update_open,
      (SELECT count(*) FROM pol p WHERE p.tablename = t.table AND p.cmd = 'DELETE'
         AND p.qual != 'true') AS delete_safe,
      (SELECT count(*) FROM pol p WHERE p.tablename = t.table AND p.cmd = 'DELETE'
         AND p.qual = 'true') AS delete_open
    FROM all_tables t
    ORDER BY t.table;
  `);
  console.table(rows);
});
