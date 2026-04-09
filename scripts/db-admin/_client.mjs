// Shared pg.Client factory for scripts in scripts/db-admin/.
// Reads credentials from .env.local (SUPABASE_DB_*). Never commit those.
//
// Every script in this folder should:
//   import { withClient } from './_client.mjs';
//   await withClient(async (client) => { ... });
//
// withClient handles connect/disconnect and fatal error logging.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from 'pg';
const { Client } = pkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '..', '.env.local');

function loadEnvLocal() {
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes if any
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

loadEnvLocal();

export function createClient() {
  const host = process.env.SUPABASE_DB_HOST;
  const port = Number(process.env.SUPABASE_DB_PORT || 5432);
  const user = process.env.SUPABASE_DB_USER;
  const database = process.env.SUPABASE_DB_NAME || 'postgres';
  const password = process.env.SUPABASE_DB_PASSWORD;

  if (!host || !user || !password) {
    console.error(
      'Missing SUPABASE_DB_HOST / SUPABASE_DB_USER / SUPABASE_DB_PASSWORD in .env.local',
    );
    process.exit(1);
  }

  return new Client({
    host,
    port,
    user,
    database,
    password,
    ssl: { rejectUnauthorized: false },
    // Fail fast on hung sockets — pooler occasionally drops connections.
    statement_timeout: 30_000,
    query_timeout: 30_000,
  });
}

export async function withClient(fn) {
  const client = createClient();
  try {
    await client.connect();
    return await fn(client);
  } catch (err) {
    console.error('\n❌ DB script failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    try {
      await client.end();
    } catch {}
  }
}
