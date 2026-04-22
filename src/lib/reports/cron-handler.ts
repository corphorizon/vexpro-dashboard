import { NextRequest, NextResponse } from 'next/server';
import {
  sendReportsForCadence,
  previousDayRange,
  previousWeekRange,
  previousMonthRange,
} from './send';
import type { ReportCadence } from './email-template';

// ─────────────────────────────────────────────────────────────────────────────
// Shared handler for the three report crons.
//
// Each cron route (`daily-financial-report`, `weekly-financial-report`,
// `monthly-financial-report`) is a 3-line file that delegates to this
// function with a different cadence + range calculator.
//
// Auth: same pattern the daily-balance-snapshot cron uses.
//   - CRON_SECRET env var MUST be set (fail closed otherwise).
//   - Inbound request MUST have `Authorization: Bearer <CRON_SECRET>`.
//   - Vercel Cron adds this header automatically.
//
// Manual trigger flags (for testing without waiting for the scheduler):
//   ?dryRun=1                 → run the whole pipeline without sending emails
//   ?onlyCompanyId=<uuid>     → limit to a single tenant
//   ?from=YYYY-MM-DD&to=...   → override the default date range
//
// These manual flags REQUIRE the same CRON_SECRET header — they are a
// developer-only escape hatch, never exposed to end users.
// ─────────────────────────────────────────────────────────────────────────────

const RANGE_FN: Record<ReportCadence, () => { from: string; to: string }> = {
  daily: previousDayRange,
  weekly: previousWeekRange,
  monthly: previousMonthRange,
};

export async function handleReportCron(
  request: NextRequest,
  cadence: ReportCadence,
) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error(`[cron/${cadence}-financial-report] CRON_SECRET not set`);
    return NextResponse.json(
      { success: false, error: 'CRON_SECRET not configured' },
      { status: 500 },
    );
  }
  if (request.headers.get('authorization') !== `Bearer ${expected}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dryRun') === '1';
  const onlyCompanyId = url.searchParams.get('onlyCompanyId') ?? undefined;
  const fromOverride = url.searchParams.get('from');
  const toOverride = url.searchParams.get('to');

  const range =
    fromOverride && toOverride
      ? { from: fromOverride, to: toOverride }
      : RANGE_FN[cadence]();

  try {
    const result = await sendReportsForCadence(cadence, range, {
      dryRun,
      onlyCompanyId,
    });
    return NextResponse.json({ success: true, ...result, dryRun });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[cron/${cadence}-financial-report]`, msg);
    return NextResponse.json(
      { success: false, error: msg, cadence, range },
      { status: 500 },
    );
  }
}
