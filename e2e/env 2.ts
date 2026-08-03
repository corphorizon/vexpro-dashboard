import fs from 'fs';
import path from 'path';

// Minimal .env.local parser (KEY=VALUE lines). dotenv is not a dependency of
// this project, and the file is simple enough to read by hand.
export const ENV_PATH = path.resolve(__dirname, '..', '.env.local');

export function loadEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// ─── Constants shared by global-setup and the specs ───
export const E2E_COMPANY_SLUG = 'e2e-test';
export const E2E_USER_EMAIL = 'e2e-admin@e2e-test.local';
export const E2E_RESERVE_PCT = 0.1;
export const E2E_PARTNERS = [
  { name: 'Socio Sesenta', percentage: 0.6 },
  { name: 'Socio Cuarenta', percentage: 0.4 },
] as const;

export function getE2EPassword(): string {
  const env = loadEnvLocal();
  const pwd = env.E2E_USER_PASSWORD;
  if (!pwd) {
    throw new Error(
      'E2E_USER_PASSWORD missing from .env.local — run the tests once (global-setup appends it) or add it manually.',
    );
  }
  return pwd;
}
