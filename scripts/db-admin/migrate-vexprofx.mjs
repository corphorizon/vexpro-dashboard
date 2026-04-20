// Phase 2 — VexPro FX migration verification + active_modules sync
//
// VexPro FX is already a row in `companies` (slug='vexprofx') and all business
// data has `company_id` pointing to it. This script:
//
//   1. Verifies VexPro's `active_modules` matches the set of modules actually
//      present in src/components/sidebar.tsx. Adds any missing ones.
//   2. Counts orphan rows (company_id IS NULL) across every business table.
//      Must be zero — if not, surfaces the list and exits non-zero.
//   3. Counts rows per table scoped to VexPro, for a before/after audit log.
//   4. IDEMPOTENT — safe to re-run; won't duplicate anything.
//
// Usage:
//   node scripts/db-admin/migrate-vexprofx.mjs [--dry-run]
//
// Requires .env.local with SUPABASE_DB_HOST / USER / PASSWORD (same as audit.mjs).

import { withClient } from './_client.mjs';

const DRY_RUN = process.argv.includes('--dry-run');

// Modules present in the dashboard sidebar (src/components/sidebar.tsx).
// When a new module is added there, include it here so new VexPro deploys
// get it enabled automatically.
const CODE_MODULES = [
  'summary',       // /resumen-general
  'movements',     // /movimientos
  'expenses',      // /egresos
  'liquidity',     // /liquidez
  'investments',   // /inversiones
  'balances',      // /balances
  'partners',      // /socios
  'upload',        // /upload (Carga de Datos)
  'periods',       // /periodos
  'hr',            // /rrhh
  'commissions',   // /comisiones
  'risk',          // /risk/retiros-*
  'users',         // /usuarios
  'audit',         // /auditoria
];

// Business tables that must have every row scoped to a company.
const SCOPED_TABLES = [
  'periods', 'deposits', 'withdrawals', 'prop_firm_sales', 'p2p_transfers',
  'expenses', 'preoperative_expenses', 'operating_income', 'broker_balance',
  'financial_status', 'partners', 'partner_distributions',
  'liquidity_movements', 'investments', 'employees', 'commercial_profiles',
  'commercial_monthly_results', 'expense_templates', 'channel_balances',
  'commercial_negotiations', 'custom_roles', 'pinned_coinsbuy_wallets',
  'audit_logs', 'company_users',
];

function log(msg) {
  console.log(msg);
}

await withClient(async (c) => {
  log('═══════════════════════════════════════════════════════════════');
  log('  PHASE 2 — VexPro FX migration verification');
  log(DRY_RUN ? '  (DRY RUN — no writes will be performed)' : '  (LIVE)');
  log('═══════════════════════════════════════════════════════════════\n');

  // ── Step 1: fetch VexPro ─────────────────────────────────────────────
  const { rows: vexRows } = await c.query(`
    SELECT id, name, slug, active_modules
    FROM companies
    WHERE slug = 'vexprofx'
    LIMIT 1
  `);
  if (vexRows.length === 0) {
    log('❌ VexPro FX not found (companies.slug = vexprofx).');
    log('   Expected row missing — nothing to migrate.');
    process.exit(1);
  }
  const vex = vexRows[0];
  log(`✓ VexPro found: id=${vex.id}, name="${vex.name}"`);
  log(`  current active_modules: ${JSON.stringify(vex.active_modules)}`);

  // ── Step 2: diff modules ─────────────────────────────────────────────
  const current = new Set(vex.active_modules || []);
  const missing = CODE_MODULES.filter((m) => !current.has(m));
  const extraneous = [...current].filter((m) => !CODE_MODULES.includes(m));

  if (missing.length === 0 && extraneous.length === 0) {
    log('✓ active_modules already in sync with code.\n');
  } else {
    if (missing.length > 0) {
      log(`⚠️  Missing modules: ${missing.join(', ')}`);
    }
    if (extraneous.length > 0) {
      log(`ℹ️  Extra modules in DB (not in code): ${extraneous.join(', ')}`);
      log('   (left intact — possibly legacy or custom)');
    }

    if (!DRY_RUN && missing.length > 0) {
      // Merge: keep extraneous, add missing. Preserve ordering from CODE_MODULES.
      const merged = [
        ...CODE_MODULES,
        ...extraneous,
      ];
      await c.query(
        `UPDATE companies SET active_modules = $1, updated_at = now() WHERE id = $2`,
        [merged, vex.id],
      );
      log(`✓ active_modules updated: ${JSON.stringify(merged)}\n`);
    } else if (DRY_RUN) {
      log('   (dry run — no changes applied)\n');
    }
  }

  // ── Step 3: orphan rows per table ────────────────────────────────────
  log('── Orphan check (rows with company_id IS NULL) ──');
  let orphanTotal = 0;
  for (const t of SCOPED_TABLES) {
    let q;
    try {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM ${t} WHERE company_id IS NULL`,
      );
      q = rows[0].n;
    } catch (err) {
      if (err.message.includes('does not exist')) {
        log(`  ${t.padEnd(32)} · table does not exist — skip`);
        continue;
      }
      throw err;
    }
    orphanTotal += q;
    const icon = q === 0 ? '✓' : '✗';
    log(`  ${icon} ${t.padEnd(32)} · orphans: ${q}`);
  }
  if (orphanTotal > 0) {
    log(`\n❌ Found ${orphanTotal} orphan rows. Cannot proceed until they are fixed.`);
    log('   Run with company_id populated or assign to VexPro manually.');
    process.exit(1);
  } else {
    log(`\n✓ No orphan rows. All data is tenant-scoped.\n`);
  }

  // ── Step 4: record count scoped to VexPro ────────────────────────────
  log('── VexPro record counts ──');
  for (const t of SCOPED_TABLES) {
    try {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM ${t} WHERE company_id = $1`,
        [vex.id],
      );
      const n = rows[0].n;
      log(`  ${t.padEnd(32)} · ${String(n).padStart(6)}`);
    } catch (err) {
      if (err.message.includes('does not exist')) continue;
      throw err;
    }
  }

  // ── Step 5: users belonging to VexPro ────────────────────────────────
  const { rows: userRows } = await c.query(
    `SELECT count(*)::int AS n FROM company_users WHERE company_id = $1`,
    [vex.id],
  );
  log(`\n✓ VexPro users: ${userRows[0].n}\n`);

  // ── Step 6: superadmin presence ──────────────────────────────────────
  const { rows: saRows } = await c.query(
    `SELECT count(*)::int AS n FROM platform_users`,
  );
  if (saRows[0].n === 0) {
    log('ℹ️  No platform_users (SUPERADMIN) yet.');
    log('   Run: node scripts/db-admin/seed-superadmin.mjs');
  } else {
    log(`✓ platform_users rows: ${saRows[0].n}`);
  }

  log('\n═══════════════════════════════════════════════════════════════');
  log('  Phase 2 verification complete.');
  log('═══════════════════════════════════════════════════════════════');
});
