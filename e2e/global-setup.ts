import fs from 'fs';
import { createClient } from '@supabase/supabase-js';
import {
  ENV_PATH,
  loadEnvLocal,
  E2E_COMPANY_SLUG,
  E2E_USER_EMAIL,
  E2E_RESERVE_PCT,
  E2E_PARTNERS,
} from './env';

// ─────────────────────────────────────────────────────────────────────────────
// Global setup — seeds the dedicated, RLS-isolated 'e2e-test' tenant.
//
// Idempotent: safe to run over and over. Uses the SERVICE ROLE key (bypasses
// RLS) strictly scoped to the e2e-test company. Production tenants are never
// touched — every write/delete filters by the e2e company_id.
// ─────────────────────────────────────────────────────────────────────────────

// Same list the app's sidebar/module system understands (src/lib/module-groups.ts).
const ALL_MODULES = [
  'summary', 'movements', 'expenses', 'liquidity', 'investments', 'balances',
  'partners', 'upload', 'periods', 'reports', 'hr', 'commissions', 'risk', 'users',
];

// Mirror of labelFor() in src/app/api/cron/create-new-period/route.ts —
// the period label is a business datum kept in Spanish ("Ago 26").
const SPANISH_MONTHS_SHORT = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
];
function labelFor(year: number, month: number): string {
  return `${SPANISH_MONTHS_SHORT[month - 1]} ${String(year).slice(-2)}`;
}

function ensurePassword(env: Record<string, string>): string {
  if (env.E2E_USER_PASSWORD) return env.E2E_USER_PASSWORD;
  // Fixed strong literal — appended once; .env.local is gitignored.
  const pwd = 'E2e!Dash-7wQx4Kp9Zr2Vt';
  fs.appendFileSync(
    ENV_PATH,
    `\n# Playwright E2E — password for ${E2E_USER_EMAIL} (seeded tenant, local only)\nE2E_USER_PASSWORD=${pwd}\n`,
  );
  console.log('[e2e-setup] Appended E2E_USER_PASSWORD to .env.local');
  return pwd;
}

// auth.admin.listUsers() returns "Database error finding users" on this
// project, so we resolve the auth user id with a read-only SQL lookup over
// the direct DB connection (same credentials scripts/db-admin uses).
async function findAuthUserByEmail(
  env: Record<string, string>,
  email: string,
): Promise<string | null> {
  const { Client } = await import('pg');
  const client = new Client({
    host: env.SUPABASE_DB_HOST,
    port: Number(env.SUPABASE_DB_PORT || 5432),
    user: env.SUPABASE_DB_USER,
    password: env.SUPABASE_DB_PASSWORD,
    database: env.SUPABASE_DB_NAME,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const res = await client.query(
      'SELECT id FROM auth.users WHERE lower(email) = lower($1) LIMIT 1',
      [email],
    );
    return res.rows[0]?.id ?? null;
  } finally {
    await client.end();
  }
}

export default async function globalSetup() {
  const env = loadEnvLocal();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local');
  }
  const password = ensurePassword(env);

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── a. Upsert company ────────────────────────────────────────────────
  const companyFields = {
    name: 'E2E Test Co',
    slug: E2E_COMPANY_SLUG,
    subdomain: E2E_COMPANY_SLUG,
    status: 'active',
    currency: 'USD',
    reserve_pct: E2E_RESERVE_PCT,
    active_modules: ALL_MODULES,
  };
  const { data: existingCompany, error: companySelErr } = await admin
    .from('companies')
    .select('id')
    .eq('slug', E2E_COMPANY_SLUG)
    .maybeSingle();
  if (companySelErr) throw new Error(`companies select failed: ${companySelErr.message}`);

  let companyId: string;
  if (existingCompany) {
    companyId = existingCompany.id;
    const { error } = await admin.from('companies').update(companyFields).eq('id', companyId);
    if (error) throw new Error(`companies update failed: ${error.message}`);
  } else {
    const { data, error } = await admin
      .from('companies')
      .insert(companyFields)
      .select('id')
      .single();
    if (error || !data) throw new Error(`companies insert failed: ${error?.message}`);
    companyId = data.id;
  }
  console.log(`[e2e-setup] Company '${E2E_COMPANY_SLUG}' → ${companyId}`);

  // ── b. Auth user with fixed password ─────────────────────────────────
  let authUserId = await findAuthUserByEmail(env, E2E_USER_EMAIL);
  if (!authUserId) {
    const { data, error } = await admin.auth.admin.createUser({
      email: E2E_USER_EMAIL,
      password,
      email_confirm: true,
    });
    if (error || !data?.user?.id) throw new Error(`auth createUser failed: ${error?.message}`);
    authUserId = data.user.id;
    console.log(`[e2e-setup] Created auth user ${E2E_USER_EMAIL}`);
  } else {
    // Keep the password in sync with .env.local so runs stay deterministic.
    const { error } = await admin.auth.admin.updateUserById(authUserId, { password });
    if (error) throw new Error(`auth updateUser failed: ${error.message}`);
  }

  // ── c. Upsert company_users membership (admin, no 2FA gates) ─────────
  const membershipFields = {
    company_id: companyId,
    user_id: authUserId,
    role: 'admin',
    name: 'E2E Admin',
    email: E2E_USER_EMAIL,
    status: 'active',
    twofa_enabled: false,
    twofa_secret: null,
    force_2fa_setup: false,
    must_change_password: false,
    preferred_language: 'es',
    allowed_modules: ALL_MODULES,
  };
  const { data: existingMembership, error: memSelErr } = await admin
    .from('company_users')
    .select('id')
    .eq('company_id', companyId)
    .eq('user_id', authUserId)
    .maybeSingle();
  if (memSelErr) throw new Error(`company_users select failed: ${memSelErr.message}`);

  if (existingMembership) {
    const { error } = await admin
      .from('company_users')
      .update(membershipFields)
      .eq('id', existingMembership.id);
    if (error) throw new Error(`company_users update failed: ${error.message}`);
  } else {
    const { error } = await admin.from('company_users').insert(membershipFields);
    if (error) throw new Error(`company_users insert failed: ${error.message}`);
  }

  // ── d. Reset tenant data ──────────────────────────────────────────────
  // Children first; deleting periods CASCADEs the period-scoped rows anyway,
  // but we delete explicitly so the reset works even for orphaned rows.
  const tablesToWipe = [
    'partner_distributions',
    'deposits',
    'withdrawals',
    'expenses',
    'operating_income',
    'prop_firm_sales',
    'p2p_transfers',
    'broker_balance',
    'financial_status',
    'liquidity_movements',
    'investments',
    // Las tablas nuevas también se limpian: una línea de ingreso que
    // sobreviva materializa su cobrado en operating_income.other y mueve la
    // distribución que T3 verifica al centavo.
    'income_lines',
    'channel_ledger_entries',
    'channel_configs',
    'business_units',
    'notifications',
    'partners',
    'periods',
  ];
  for (const table of tablesToWipe) {
    const { error } = await admin.from(table).delete().eq('company_id', companyId);
    if (error) throw new Error(`wipe ${table} failed: ${error.message}`);
  }
  console.log('[e2e-setup] Tenant data wiped');

  // One period for the current month, label format mirrors the cron job.
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const { error: periodErr } = await admin.from('periods').insert({
    company_id: companyId,
    year,
    month,
    label: labelFor(year, month),
    is_closed: false,
  });
  if (periodErr) throw new Error(`periods insert failed: ${periodErr.message}`);

  // Two partners, 60/40 (percentage stored as fraction 0..1 — the app
  // compares Σ against 1 and formats via formatPercent).
  const { error: partnersErr } = await admin.from('partners').insert(
    E2E_PARTNERS.map((p) => ({
      company_id: companyId,
      name: p.name,
      percentage: p.percentage,
    })),
  );
  if (partnersErr) throw new Error(`partners insert failed: ${partnersErr.message}`);

  console.log(`[e2e-setup] Seeded period ${labelFor(year, month)} + partners 60/40. Done.`);
}
