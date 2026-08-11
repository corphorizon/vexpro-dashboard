import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// GET /api/health
//
// Minimal liveness + readiness probe for external uptime monitors
// (UptimeRobot, Better Stack, etc.).
//
// What it checks:
//   · The app process itself is responding (implicit — we got the request)
//   · Supabase is reachable and authoritative (SELECT 1-style ping)
//
// What it deliberately does NOT do:
//   · Authentication. Monitors can't hold a session, so this endpoint is
//     public. Response contains zero PII and zero tenant data.
//   · External API checks (Coinsbuy / UniPayment / FairPay). Those are
//     best-effort — we don't want an uptime alert at 3am because a third
//     party rate-limited us.
//   · Publish the git SHA. Antes la respuesta pública incluía `version` con el
//     commit SHA, útil para un atacante para mapear el código desplegado. Se
//     quitó; el contrato con el monitor es solo { ok, db, timestamp }.
//
// ANTI-FLOOD: el endpoint es PÚBLICO y pega a la DB con service_role. Sin
// caché, un flood se traduce 1:1 en queries a Supabase. Cacheamos el resultado
// del ping ~60s en una variable de módulo: mientras el resultado esté fresco no
// se toca la DB, así un flood no puede amplificarse contra Supabase.
//
// Response shape: { ok: true, timestamp, db: 'ok' }
// On DB failure: { ok: false, db: 'error' } with 503 status.
// ---------------------------------------------------------------------------

const DB_PING_TTL_MS = 60_000;

// Caché del último ping a la DB, compartida por todas las requests del mismo
// worker. `db: 'unreachable'` NO se cachea: un fallo transitorio de red no debe
// silenciar 60s de chequeos.
let cachedPing: { db: 'ok' | 'error'; at: number } | null = null;

async function pingDb(): Promise<'ok' | 'error' | 'unreachable'> {
  const now = Date.now();
  if (cachedPing && now - cachedPing.at < DB_PING_TTL_MS) {
    return cachedPing.db;
  }

  try {
    const admin = createAdminClient();
    // Cheapest possible read against the DB. `companies` is small (<100 rows)
    // and always-populated; we just need to prove Supabase is responsive.
    const { error } = await admin.from('companies').select('id').limit(1);
    const db: 'ok' | 'error' = error ? 'error' : 'ok';
    cachedPing = { db, at: now };
    return db;
  } catch {
    // No se cachea: fallo transitorio de red/proceso.
    return 'unreachable';
  }
}

export async function GET() {
  const timestamp = new Date().toISOString();
  const db = await pingDb();

  if (db === 'ok') {
    return NextResponse.json({ ok: true, timestamp, db: 'ok' }, { status: 200 });
  }
  return NextResponse.json({ ok: false, timestamp, db }, { status: 503 });
}
