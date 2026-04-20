// Phase 2 — Seed the initial SUPERADMIN for Horizon Consulting.
//
// IDEMPOTENT: if a superadmin row already exists, exits cleanly without
// creating duplicates.
//
// What it does:
//   1. Check platform_users — if any row exists, abort (superadmin already seeded).
//   2. Check auth.users for the target email — reuse if present (don't duplicate).
//   3. If no auth user: invite by email via Supabase Admin API. This creates
//      the auth.user row (confirmed_at = NULL) AND sends a recovery/invite
//      email so the user sets their password on first access.
//   4. Insert a row in platform_users pointing to that auth.user.id.
//   5. Verify and report.
//
// Requirements in .env.local:
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SUPABASE_DB_HOST / SUPABASE_DB_USER / SUPABASE_DB_PASSWORD  (for pg)
//
// Usage:
//   node scripts/db-admin/seed-superadmin.mjs
//
// Optional flags:
//   --email=<custom@email>   Override default admin@horizonconsulting.ai
//   --name="Full Name"       Override default display name
//   --redirect=<url>         Where the invite link should land

import { withClient } from './_client.mjs';
import { createClient as createSbClient } from '@supabase/supabase-js';

// ── Args ────────────────────────────────────────────────────────────────
function argVal(name, fallback) {
  const flag = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(flag));
  return arg ? arg.slice(flag.length) : fallback;
}

const TARGET_EMAIL = argVal('email', 'admin@horizonconsulting.ai');
const TARGET_NAME = argVal('name', 'Horizon Consulting Admin');
const REDIRECT_URL = argVal(
  'redirect',
  'http://localhost:3100/reset-password',
);

// ── Supabase admin client ───────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    '❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local',
  );
  process.exit(1);
}

const sb = createSbClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Main ────────────────────────────────────────────────────────────────
await withClient(async (c) => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  PHASE 2 — Seed initial SUPERADMIN');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Email:    ${TARGET_EMAIL}`);
  console.log(`  Name:     ${TARGET_NAME}`);
  console.log(`  Redirect: ${REDIRECT_URL}\n`);

  // ── 1. Guard — already seeded? ────────────────────────────────────────
  const { rows: existing } = await c.query(
    `SELECT id, user_id, email FROM platform_users LIMIT 5`,
  );
  if (existing.length > 0) {
    console.log('ℹ️  platform_users is NOT empty — aborting to avoid duplicates:');
    for (const r of existing) console.log(`     · ${r.email}  (user_id=${r.user_id})`);
    console.log('\nIf you want to force re-seed, delete the row manually and re-run.');
    return;
  }

  // ── 2. Look for existing auth.users with this email ───────────────────
  // The Admin API exposes listUsers (paginated) and getUserById. For emails
  // we grep the first page; adequate for our single-superadmin case.
  console.log('→ Checking auth.users for existing email...');
  const { data: listed, error: listErr } = await sb.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (listErr) throw new Error(`auth.admin.listUsers failed: ${listErr.message}`);
  let authUser = listed?.users?.find(
    (u) => u.email?.toLowerCase() === TARGET_EMAIL.toLowerCase(),
  );

  if (authUser) {
    console.log(`✓ Found existing auth.user: ${authUser.id}`);
    console.log(
      `  (reusing — no new invite email sent; call resetPasswordForEmail if needed)`,
    );
  } else {
    // ── 3. Invite via Admin API ─────────────────────────────────────────
    console.log('→ No existing auth.user — creating via inviteUserByEmail...');
    const { data: invited, error: invErr } = await sb.auth.admin.inviteUserByEmail(
      TARGET_EMAIL,
      {
        data: { name: TARGET_NAME, role: 'superadmin' },
        redirectTo: REDIRECT_URL,
      },
    );
    if (invErr) {
      throw new Error(`auth.admin.inviteUserByEmail failed: ${invErr.message}`);
    }
    authUser = invited?.user;
    console.log(`✓ Invite sent: auth.user.id = ${authUser.id}`);
    console.log(
      `  An email has been dispatched to ${TARGET_EMAIL} so the user sets a password.`,
    );
  }

  // ── 4. Insert platform_users row ──────────────────────────────────────
  console.log('→ Inserting platform_users row...');
  const { rows: inserted } = await c.query(
    `
      INSERT INTO platform_users (user_id, name, email, role)
      VALUES ($1, $2, $3, 'superadmin')
      ON CONFLICT (user_id) DO UPDATE
        SET name = EXCLUDED.name, email = EXCLUDED.email, updated_at = now()
      RETURNING id, user_id, email, created_at
    `,
    [authUser.id, TARGET_NAME, TARGET_EMAIL],
  );
  console.log(`✓ platform_users id: ${inserted[0].id}`);
  console.log(`  user_id:  ${inserted[0].user_id}`);
  console.log(`  email:    ${inserted[0].email}`);
  console.log(`  created:  ${inserted[0].created_at}\n`);

  // ── 5. Verification ───────────────────────────────────────────────────
  const { rows: count } = await c.query(
    `SELECT count(*)::int AS n FROM platform_users`,
  );
  console.log(`✓ platform_users total rows: ${count[0].n}`);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  ✅ Superadmin seeded successfully.');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('\n  Next step: the user needs to check their email for the invite');
  console.log('  link and set a password before their first login. If no email');
  console.log('  arrives within 5 minutes, resend with:\n');
  console.log(`    const { error } = await sb.auth.resetPasswordForEmail('${TARGET_EMAIL}')`);
  console.log('\n  Once the password is set, login at /login and the redirect');
  console.log('  logic (Phase 3) will send them to /superadmin.');
});
