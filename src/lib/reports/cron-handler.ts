import { NextRequest, NextResponse } from 'next/server';
import {
  sendReportsForCadence,
  previousDayRange,
  previousWeekRange,
  previousMonthRange,
} from './send';
import type { ReportCadence } from './email-template';
import { getLastSyncStatus, runExternalApiSync } from '@/lib/integrations-sync';

// If the last successful sync of external APIs is older than this many
// minutes, the report cron triggers a fresh sync before sending. Keeps
// the email from going out with 30-hour-old data when the periodic 23:55
// UTC sync has been broken for any reason.
const SYNC_FRESHNESS_MINUTES = 15;

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

  // ── Safety net: ensure data is fresh AND complete before sending ─────
  // We re-run the sync inline when ANY of the following is true:
  //   1. No sync has ever run (lastSyncedAt is null).
  //   2. Last sync is older than SYNC_FRESHNESS_MINUTES.
  //   3. Last sync is fresh BUT some provider failed (e.g. UniPayment 403).
  //      A "successful" sync that silently dropped one provider would have
  //      otherwise let a stale email go out — exactly the bug that caused
  //      reports to show $61K instead of the real $260K on Apr 27.
  let syncInfo: {
    lastSyncedAt: string | null;
    ranInlineSync: boolean;
    failedProviders: string[];
  } = {
    lastSyncedAt: null,
    ranInlineSync: false,
    failedProviders: [],
  };
  try {
    const status = await getLastSyncStatus(onlyCompanyId);
    const lastSyncAt = status?.ranAt ?? null;
    const tooOld =
      !lastSyncAt ||
      Date.now() - new Date(lastSyncAt).getTime() > SYNC_FRESHNESS_MINUTES * 60 * 1000;
    const incomplete = !!status && !status.allOk;
    const stale = tooOld || incomplete;

    if (stale) {
      const reason = tooOld
        ? `older than ${SYNC_FRESHNESS_MINUTES} min (last: ${lastSyncAt ?? 'never'})`
        : `previous sync had failures: ${JSON.stringify(status?.perCompanyFailed)}`;
      console.log(
        `[cron/${cadence}-financial-report] running inline sync — ${reason}`,
      );
      const summary = await runExternalApiSync({ onlyCompanyId });
      syncInfo = {
        lastSyncedAt: summary.ranAt,
        ranInlineSync: true,
        failedProviders: summary.details
          .filter((d) => d.status === 'error')
          .map((d) => `${d.company_name}/${d.provider}`),
      };
    } else {
      syncInfo = { lastSyncedAt: lastSyncAt, ranInlineSync: false, failedProviders: [] };
    }
  } catch (err) {
    // Sync failure is logged but never blocks the report — better to send
    // with slightly stale data than to skip the day entirely.
    console.warn(
      `[cron/${cadence}-financial-report] safety-net sync failed:`,
      err instanceof Error ? err.message : err,
    );
  }

  try {
    const result = await sendReportsForCadence(cadence, range, {
      dryRun,
      onlyCompanyId,
      lastSyncedAt: syncInfo.lastSyncedAt,
    });
    return NextResponse.json({ success: true, ...result, dryRun, syncInfo });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[cron/${cadence}-financial-report]`, msg);
    return NextResponse.json(
      { success: false, error: msg, cadence, range, syncInfo },
      { status: 500 },
    );
  }
}
