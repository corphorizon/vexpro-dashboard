// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cron/sync-external-apis
//
// Periodic multi-tenant sync of Coinsbuy / FairPay / UniPayment / Orion CRM.
// Vercel Cron hits this 4× per day (see vercel.json). The 23:55 UTC run is
// the critical one — it primes the data right before the daily-financial-
// report cron at 00:05 UTC.
//
// Auth: shared CRON_SECRET pattern.
//   - Inbound `Authorization: Bearer <CRON_SECRET>` required.
//   - Vercel Cron sets it automatically.
//
// Manual trigger flags (CRON_SECRET still required):
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   → override default 35-day window
//   ?onlyCompanyId=<uuid>            → limit to a single tenant
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { runExternalApiSync } from '@/lib/integrations-sync';

export const maxDuration = 300; // up to 5 min: external APIs can be slow

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron/sync-external-apis] CRON_SECRET not set');
    return NextResponse.json(
      { success: false, error: 'CRON_SECRET not configured' },
      { status: 500 },
    );
  }
  if (request.headers.get('authorization') !== `Bearer ${expected}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const onlyCompanyId = url.searchParams.get('onlyCompanyId') ?? undefined;

  try {
    const summary = await runExternalApiSync({
      windowFrom: from,
      windowTo: to,
      onlyCompanyId,
    });
    return NextResponse.json({ success: true, ...summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[cron/sync-external-apis]', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
