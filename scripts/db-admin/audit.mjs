// Read-only Supabase database audit.
// Runs a suite of health-check queries and prints a human report.
//
// What it checks:
//   1. Tables in `public` without RLS enabled (critical — anon can read all)
//   2. "Permissive true" policies (qual = 'true' or with_check = 'true')
//      on any table, especially financial tables
//   3. Foreign keys without supporting indexes (slow joins / deletes)
//   4. Tables scanned mostly via seq-scan (missing index heuristic)
//   5. Unused indexes (idx_scan = 0 and > 1MB)
//   6. Table sizes (total + indexes)
//   7. Orphan auth.users without a company_users row
//   8. Duplicate indexes (same columns, different name)
//
// Nothing here writes — safe to run any time.

import { withClient } from './_client.mjs';

const SECTIONS = [];
function section(title, rows, opts = {}) {
  SECTIONS.push({ title, rows, ...opts });
}

await withClient(async (c) => {
  // ── 1. Tables without RLS ──────────────────────────────────────────────
  {
    const { rows } = await c.query(`
      SELECT n.nspname AS schema, cls.relname AS table, cls.relrowsecurity AS rls_on
      FROM pg_class cls
      JOIN pg_namespace n ON n.oid = cls.relnamespace
      WHERE cls.relkind = 'r'
        AND n.nspname = 'public'
      ORDER BY cls.relrowsecurity, cls.relname;
    `);
    section(
      '1. RLS coverage (public schema)',
      rows,
      { severity: rows.some((r) => !r.rls_on) ? 'critical' : 'ok' },
    );
  }

  // ── 2. Permissive "true" policies ──────────────────────────────────────
  {
    const { rows } = await c.query(`
      SELECT schemaname, tablename, policyname, cmd, qual, with_check, roles
      FROM pg_policies
      WHERE schemaname = 'public'
        AND (qual = 'true' OR with_check = 'true')
      ORDER BY tablename, policyname;
    `);
    section('2. Permissive "true" policies (public read/write)', rows, {
      severity: rows.length > 0 ? 'critical' : 'ok',
    });
  }

  // ── 2b. Policy count per table/cmd ─────────────────────────────────────
  {
    const { rows } = await c.query(`
      SELECT tablename, cmd, count(*) AS n
      FROM pg_policies
      WHERE schemaname = 'public'
      GROUP BY tablename, cmd
      HAVING count(*) > 1
      ORDER BY tablename, cmd;
    `);
    section('2b. Duplicate policies (same table + cmd)', rows, {
      severity: rows.length > 0 ? 'warn' : 'ok',
    });
  }

  // ── 3. FKs without supporting index ────────────────────────────────────
  {
    const { rows } = await c.query(`
      SELECT c.conrelid::regclass AS table,
             a.attname              AS column,
             c.conname              AS fk_name
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'f'
        AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid
            AND a.attnum = ANY(i.indkey)
            AND (i.indkey::int[])[0] = a.attnum  -- column is first in index
        )
      ORDER BY c.conrelid::regclass::text, a.attname;
    `);
    section('3. Foreign keys without supporting index', rows, {
      severity: rows.length > 0 ? 'warn' : 'ok',
    });
  }

  // ── 4. Seq-scan heavy tables ───────────────────────────────────────────
  {
    const { rows } = await c.query(`
      SELECT relname AS table,
             seq_scan,
             idx_scan,
             n_live_tup AS rows,
             CASE WHEN seq_scan + idx_scan = 0 THEN 0
                  ELSE round(100.0 * seq_scan / (seq_scan + idx_scan), 1)
             END AS seq_pct
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
        AND n_live_tup > 100
      ORDER BY seq_scan DESC
      LIMIT 15;
    `);
    section('4. Seq-scan heavy tables (top 15, >100 rows)', rows);
  }

  // ── 5. Unused indexes ──────────────────────────────────────────────────
  {
    const { rows } = await c.query(`
      SELECT s.relname AS table,
             s.indexrelname AS index,
             s.idx_scan,
             pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
      FROM pg_stat_user_indexes s
      JOIN pg_index i ON i.indexrelid = s.indexrelid
      WHERE s.schemaname = 'public'
        AND s.idx_scan = 0
        AND NOT i.indisunique
        AND NOT i.indisprimary
        AND pg_relation_size(s.indexrelid) > 1024 * 1024
      ORDER BY pg_relation_size(s.indexrelid) DESC;
    `);
    section('5. Unused non-unique indexes (>1MB)', rows);
  }

  // ── 6. Table sizes ─────────────────────────────────────────────────────
  {
    const { rows } = await c.query(`
      SELECT relname AS table,
             n_live_tup AS rows,
             pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
             pg_size_pretty(pg_relation_size(relid)) AS heap_size,
             pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS idx_size
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 20;
    `);
    section('6. Top 20 tables by size', rows);
  }

  // ── 7. Orphan auth.users ───────────────────────────────────────────────
  {
    const { rows } = await c.query(`
      SELECT u.id, u.email, u.created_at
      FROM auth.users u
      LEFT JOIN public.company_users cu ON cu.user_id = u.id
      WHERE cu.user_id IS NULL
      ORDER BY u.created_at DESC;
    `);
    section('7. auth.users without a company_users row', rows, {
      severity: rows.length > 0 ? 'warn' : 'ok',
    });
  }

  // ── 8. Duplicate indexes ───────────────────────────────────────────────
  {
    const { rows } = await c.query(`
      SELECT indrelid::regclass AS table,
             array_agg(indexrelid::regclass::text ORDER BY indexrelid) AS indexes,
             indkey::text AS columns
      FROM pg_index
      WHERE indrelid IN (
        SELECT oid FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
      )
      GROUP BY indrelid, indkey
      HAVING count(*) > 1;
    `);
    section('8. Duplicate indexes (same columns)', rows, {
      severity: rows.length > 0 ? 'warn' : 'ok',
    });
  }

  // ── 9. Row counts per company on key tables ────────────────────────────
  {
    const tables = [
      'companies',
      'company_users',
      'employees',
      'commercial_profiles',
      'deposits',
      'withdrawals',
      'expenses',
    ];
    const rows = [];
    for (const t of tables) {
      const r = await c.query(`SELECT count(*)::int AS n FROM public.${t};`);
      rows.push({ table: t, rows: r.rows[0].n });
    }
    section('9. Row counts on key tables', rows);
  }

  // ── 10. pg_stat_statements top slow queries (if extension enabled) ─────
  {
    try {
      const { rows } = await c.query(`
        SELECT substring(query, 1, 80) AS query,
               calls,
               round(mean_exec_time::numeric, 1) AS mean_ms,
               round(total_exec_time::numeric, 0) AS total_ms
        FROM pg_stat_statements
        WHERE query NOT ILIKE '%pg_stat_statements%'
          AND query NOT ILIKE '%pg_catalog%'
        ORDER BY mean_exec_time DESC
        LIMIT 10;
      `);
      section('10. Slowest queries by mean time (top 10)', rows);
    } catch (err) {
      section('10. pg_stat_statements', [{ note: 'extension not enabled — skipped' }]);
    }
  }
});

// ── Render report ────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  SUPABASE DB AUDIT REPORT');
console.log('═══════════════════════════════════════════════════════════\n');

for (const s of SECTIONS) {
  const badge =
    s.severity === 'critical' ? ' 🔴 CRITICAL'
    : s.severity === 'warn'    ? ' 🟡 WARN'
    : s.severity === 'ok'      ? ' ✅'
    : '';
  console.log(`\n── ${s.title}${badge} ──`);
  if (!s.rows || s.rows.length === 0) {
    console.log('  (no rows)');
  } else {
    console.table(s.rows);
  }
}

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  END OF REPORT');
console.log('═══════════════════════════════════════════════════════════\n');
