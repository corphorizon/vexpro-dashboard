// One-off: set a password for the platform superadmin so Kevin can log in
// immediately (bypassing the email-invite flow).
//
// Usage:
//   node scripts/db-admin/set-superadmin-password.mjs <email> <newPassword>

import { createClient as createSbClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '..', '.env.local');

for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!(key in process.env)) process.env[key] = value;
}

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node set-superadmin-password.mjs <email> <password>');
  process.exit(1);
}

const sb = createSbClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// Look up the auth user id via pg (admin.listUsers is flaky in our tenant).
console.log(`→ Looking up ${email} via SQL...`);
const { default: pkg } = await import('pg');
const { Client } = pkg;
const client = new Client({
  host: process.env.SUPABASE_DB_HOST,
  port: Number(process.env.SUPABASE_DB_PORT || 5432),
  user: process.env.SUPABASE_DB_USER,
  database: process.env.SUPABASE_DB_NAME || 'postgres',
  password: process.env.SUPABASE_DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});
await client.connect();
const { rows } = await client.query(
  `SELECT id FROM auth.users WHERE lower(email) = lower($1) LIMIT 1`,
  [email],
);
await client.end();

if (rows.length === 0) {
  console.error(`❌ Could not locate auth user for ${email}`);
  process.exit(1);
}
const userId = rows[0].id;

console.log(`✓ Found auth.user ${userId}`);
console.log('→ Updating password + confirming email...');

const { error: updErr } = await sb.auth.admin.updateUserById(userId, {
  password,
  email_confirm: true,
});

if (updErr) {
  console.error(`❌ updateUserById failed: ${updErr.message}`);
  process.exit(1);
}

console.log(`✅ Password updated for ${email}.`);
console.log(`\n  Login credentials:`);
console.log(`    URL:      http://localhost:3100/login`);
console.log(`    Email:    ${email}`);
console.log(`    Password: ${password}`);
console.log(`\n  Once logged in, go to /perfil and change the password to something only you know.`);
