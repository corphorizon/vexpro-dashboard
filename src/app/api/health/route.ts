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
//
// Response shape: { ok: true, version, timestamp, db: 'ok' }
// On DB failure: { ok: false, db: 'error' } with 503 status.
// ---------------------------------------------------------------------------

export async function GET() {
  const timestamp = new Date().toISOString();
  const version =
    process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ||
    'dev';

  try {
    const admin = createAdminClient();
    // Cheapest possible read against the DB. `companies` is small (<100 rows)
    // and always-populated; we just need to prove Supabase is responsive.
    const { error } = await admin.from('companies').select('id').limit(1);

    if (error) {
      return NextResponse.json(
        { ok: false, version, timestamp, db: 'error' },
        { status: 503 },
      );
    }

    return NextResponse.json(
      { ok: true, version, timestamp, db: 'ok' },
      { status: 200 },
    );
  } catch {
    return NextResponse.json(
      { ok: false, version, timestamp, db: 'unreachable' },
      { status: 503 },
    );
  }
}
