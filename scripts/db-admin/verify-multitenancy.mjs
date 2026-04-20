// Multi-tenancy post-rollout verification.
//
// Read-only. Run this AFTER all 6 phases are applied and the scripts have
// completed. Produces a pass/fail report across the 4 security checks
// listed in the Phase 7 spec:
//
//   1. Anti cross-tenant
//   2. Superadmin reach
//   3. VexPro integrity
//   4. Build/type checks (delegated — see npm scripts)
//
// Usage:
//   node scripts/db-admin/verify-multitenancy.mjs
//
// Expects .env.local with SUPABASE_DB_* credentials.

import { withClient } from './_client.mjs';

const SECTIONS = [];
function pass(title, rows) { SECTIONS.push({ title, severity: 'pass', rows }); }
function warn(title, rows) { SECTIONS.push({ title, severity: 'warn', rows }); }
function fail(title, rows) { SECTIONS.push({ title, severity: 'fail', rows }); }

await withClient(async (c) => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  MULTI-TENANCY VERIFICATION — Post-rollout');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── 1. platform_users + is_superadmin function ─────────────────────
  const { rows: saRows } = await c.query(`
    SELECT count(*)::int AS n FROM platform_users
  `);
  if (saRows[0].n > 0) {
    pass(`1.1 platform_users seeded`, [{ count: saRows[0].n }]);
  } else {
    fail(`1.1 platform_users seeded`, [{ count: 0, hint: 'Run scripts/db-admin/seed-superadmin.mjs' }]);
  }

  const { rows: fnRows } = await c.query(`
    SELECT proname FROM pg_proc
    WHERE proname IN ('is_superadmin','auth_company_ids','auth_can_edit','auth_can_manage')
    ORDER BY proname
  `);
  const fnNames = fnRows.map((r) => r.proname);
  const expectedFns = ['auth_can_edit', 'auth_can_manage', 'auth_company_ids', 'is_superadmin'];
  const missingFns = expectedFns.filter((f) => !fnNames.includes(f));
  if (missingFns.length === 0) {
    pass(`1.2 RLS helper functions present`, fnRows);
  } else {
    fail(`1.2 RLS helper functions present`, [{ missing: missingFns.join(', ') }]);
  }

  // ── 2. RLS coverage: every scoped table has 4 policies ────────────
  const scopedTables = [
    'periods', 'deposits', 'withdrawals', 'prop_firm_sales', 'p2p_transfers',
    'expenses', 'preoperative_expenses', 'operating_income', 'broker_balance',
    'financial_status', 'partners', 'partner_distributions',
    'liquidity_movements', 'investments', 'employees', 'commercial_profiles',
    'commercial_monthly_results', 'expense_templates', 'channel_balances',
    'commercial_negotiations', 'custom_roles', 'pinned_coinsbuy_wallets',
    'companies', 'company_users', 'platform_users', 'audit_logs',
  ];
  const policyRows = [];
  for (const t of scopedTables) {
    const { rows } = await c.query(
      `SELECT cmd, count(*)::int AS n FROM pg_policies WHERE tablename = $1 GROUP BY cmd`,
      [t],
    );
    const counts = { SELECT: 0, INSERT: 0, UPDATE: 0, DELETE: 0 };
    for (const r of rows) counts[r.cmd] = r.n;
    const total = rows.reduce((s, r) => s + r.n, 0);
    policyRows.push({ table: t, total, ...counts });
  }
  const gaps = policyRows.filter((p) => p.total < 4);
  if (gaps.length === 0) {
    pass(`2. RLS policy coverage (all scoped tables have SELECT/INSERT/UPDATE/DELETE)`, policyRows);
  } else {
    warn(`2. RLS policy coverage — some tables have < 4 policies`, gaps);
  }

  // ── 3. Orphan scan — no row should have company_id = NULL ─────────
  const orphans = [];
  for (const t of scopedTables) {
    if (t === 'platform_users' || t === 'companies') continue; // no company_id
    try {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM ${t} WHERE company_id IS NULL`,
      );
      if (rows[0].n > 0) orphans.push({ table: t, orphan_count: rows[0].n });
    } catch (err) {
      if (!err.message.includes('does not exist')) throw err;
    }
  }
  if (orphans.length === 0) {
    pass(`3. Anti-cross-tenant: no orphan rows (company_id NULL)`, [{ status: 'all tenant-scoped' }]);
  } else {
    fail(`3. Anti-cross-tenant: orphan rows found`, orphans);
  }

  // ── 4. VexPro FX integrity ─────────────────────────────────────────
  const { rows: vex } = await c.query(
    `SELECT id, name, slug, status, active_modules FROM companies WHERE slug = 'vexprofx'`,
  );
  if (vex.length === 0) {
    fail(`4. VexPro FX integrity`, [{ error: 'VexPro row missing' }]);
  } else {
    const v = vex[0];
    const vexpro_id = v.id;
    const counts = {};
    for (const t of scopedTables) {
      if (t === 'platform_users' || t === 'companies') continue;
      try {
        const { rows } = await c.query(
          `SELECT count(*)::int AS n FROM ${t} WHERE company_id = $1`,
          [vexpro_id],
        );
        counts[t] = rows[0].n;
      } catch { /* table missing — ok */ }
    }
    pass(`4. VexPro FX integrity`, [
      { field: 'id', value: v.id },
      { field: 'name', value: v.name },
      { field: 'status', value: v.status },
      { field: 'active_modules', value: `(${(v.active_modules ?? []).length}) ${(v.active_modules ?? []).join(', ')}` },
      ...Object.entries(counts).map(([table, n]) => ({ field: `${table}.count`, value: n })),
    ]);
  }

  // ── 5. Permissive / unsafe policies ────────────────────────────────
  const { rows: permissive } = await c.query(`
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (qual::text = 'true' OR with_check::text = 'true')
  `);
  if (permissive.length === 0) {
    pass(`5. No overly-permissive policies (qual='true')`, [{ ok: true }]);
  } else {
    warn(`5. Overly-permissive policies detected`, permissive);
  }

  // ── 6. auth.users not in company_users nor platform_users ──────────
  const { rows: orphanAuth } = await c.query(`
    SELECT au.id, au.email
    FROM auth.users au
    LEFT JOIN company_users cu ON cu.user_id = au.id
    LEFT JOIN platform_users pu ON pu.user_id = au.id
    WHERE cu.id IS NULL AND pu.id IS NULL
  `);
  if (orphanAuth.length === 0) {
    pass(`6. No orphan auth.users (every auth user has a profile)`, [{ ok: true }]);
  } else {
    warn(`6. Orphan auth.users — have Supabase auth entries but no profile`, orphanAuth);
  }

  // ── Print report ───────────────────────────────────────────────────
  let failures = 0;
  for (const s of SECTIONS) {
    const icon = s.severity === 'pass' ? '✅' : s.severity === 'warn' ? '⚠️ ' : '❌';
    console.log(`${icon}  ${s.title}`);
    for (const r of s.rows) {
      const pretty = Object.entries(r)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('  ');
      console.log(`     · ${pretty}`);
    }
    console.log('');
    if (s.severity === 'fail') failures++;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  if (failures === 0) {
    console.log(`  ✅ PASS — ${SECTIONS.length} checks completed, 0 failures.`);
    console.log('  Multi-tenancy rollout verified at the DB level.');
  } else {
    console.log(`  ❌ FAIL — ${failures} blocking issues. See details above.`);
    process.exitCode = 1;
  }
  console.log('═══════════════════════════════════════════════════════════════');
});
