// ─────────────────────────────────────────────────────────────────────────────
// /api/cron/create-new-period
//
// Vercel Cron schedule: "1 0 1 * *" — runs 00:01 UTC on the 1st of every
// month, 4 minutes BEFORE the monthly-financial-report cron at 00:05 so the
// new period exists by the time the monthly report tries to read it.
//
// What it does, per active company:
//   1. Compute the current UTC year/month.
//   2. If a period for (company_id, year, month) already exists → skip.
//   3. Otherwise INSERT it with `is_closed=false` and inherit the previous
//      period's `reserve_pct` (or fall back to 0.10).
//   4. Write an audit_log row with `user_id='system:cron'`.
//   5. Notify each admin of the company by email — informs that the new
//      period is open AND that the previous period is still open for
//      manual review/close.
//
// The previous period is intentionally NOT closed automatically. Closing is
// a finance decision (after reconciliation, partner distribution, etc.) so
// it stays manual. The cron only opens.
//
// Auth: same `Authorization: Bearer <CRON_SECRET>` pattern as the rest of
// `/api/cron/*`. Vercel Cron sets this header automatically. Manual triggers
// for testing must include it.
//
// Manual flags (require the same secret):
//   ?dryRun=1         → run the full pipeline without inserting/sending
//   ?targetYear=2026  → override target year (default: now UTC)
//   ?targetMonth=5    → override target month (1-12; default: now UTC)
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendNotificationEmail } from '@/services/emailService';

const SPANISH_MONTHS_SHORT = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
];
const SPANISH_MONTHS_LONG = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function labelFor(year: number, month: number): string {
  return `${SPANISH_MONTHS_SHORT[month - 1]} ${String(year).slice(-2)}`;
}
function fullName(year: number, month: number): string {
  return `${SPANISH_MONTHS_LONG[month - 1]} ${year}`;
}

type CompanyRow = {
  id: string;
  name: string;
  slug: string;
  status: string;
};
type AdminRow = { name: string | null; email: string };
type PerCompanyResult = {
  company_id: string;
  company_name: string;
  outcome: 'created' | 'skipped_exists' | 'error';
  period_id?: string;
  emailed?: number;
  email_failures?: number;
  error?: string;
};

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error('[cron/create-new-period] CRON_SECRET not configured');
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

  // Resolve target year/month from query overrides or UTC now.
  const now = new Date();
  const overrideYear = url.searchParams.get('targetYear');
  const overrideMonth = url.searchParams.get('targetMonth');
  const targetYear = overrideYear ? Number(overrideYear) : now.getUTCFullYear();
  const targetMonth = overrideMonth ? Number(overrideMonth) : now.getUTCMonth() + 1;
  if (
    !Number.isInteger(targetYear) ||
    !Number.isInteger(targetMonth) ||
    targetMonth < 1 ||
    targetMonth > 12
  ) {
    return NextResponse.json(
      { success: false, error: 'targetYear/targetMonth inválidos' },
      { status: 400 },
    );
  }
  // Previous month for the email message ("April still open").
  const prevYear = targetMonth === 1 ? targetYear - 1 : targetYear;
  const prevMonth = targetMonth === 1 ? 12 : targetMonth - 1;

  const admin = createAdminClient();

  const { data: companies, error: companiesError } = await admin
    .from('companies')
    .select('id, name, slug, status')
    .eq('status', 'active');

  if (companiesError) {
    return NextResponse.json(
      { success: false, error: `companies query: ${companiesError.message}` },
      { status: 500 },
    );
  }

  const results: PerCompanyResult[] = [];

  for (const c of (companies ?? []) as CompanyRow[]) {
    try {
      // 1. Skip if already exists.
      const { data: existing } = await admin
        .from('periods')
        .select('id')
        .eq('company_id', c.id)
        .eq('year', targetYear)
        .eq('month', targetMonth)
        .maybeSingle();

      if (existing) {
        results.push({
          company_id: c.id,
          company_name: c.name,
          outcome: 'skipped_exists',
          period_id: existing.id as string,
        });
        continue;
      }

      if (dryRun) {
        results.push({
          company_id: c.id,
          company_name: c.name,
          outcome: 'created',
          period_id: 'dry-run',
        });
        continue;
      }

      // 2. Inherit reserve_pct from the most recent period of this company,
      //    falling back to 0.10 (the table default).
      const { data: prior } = await admin
        .from('periods')
        .select('reserve_pct')
        .eq('company_id', c.id)
        .order('year', { ascending: false })
        .order('month', { ascending: false })
        .limit(1)
        .maybeSingle();

      const reservePct =
        prior && prior.reserve_pct != null ? Number(prior.reserve_pct) : 0.1;

      // 3. Insert.
      const label = labelFor(targetYear, targetMonth);
      const { data: inserted, error: insertError } = await admin
        .from('periods')
        .insert({
          company_id: c.id,
          year: targetYear,
          month: targetMonth,
          label,
          is_closed: false,
          reserve_pct: reservePct,
        })
        .select('id')
        .single();

      if (insertError || !inserted) {
        throw new Error(insertError?.message ?? 'insert failed without error');
      }

      // 4. Audit. Best-effort.
      await admin.from('audit_logs').insert({
        company_id: c.id,
        user_id: 'system:cron',
        user_name: 'system',
        action: 'create',
        module: 'periods',
        details: JSON.stringify({
          period_id: inserted.id,
          year: targetYear,
          month: targetMonth,
          label,
          source: 'create-new-period cron',
        }),
      });

      // 5. Notify admins of this company.
      const { data: admins } = await admin
        .from('company_users')
        .select('name, email')
        .eq('company_id', c.id)
        .eq('role', 'admin')
        .eq('status', 'active');

      let emailed = 0;
      let emailFailures = 0;
      for (const a of (admins ?? []) as AdminRow[]) {
        if (!a.email) continue;
        try {
          const message =
            `Se ha creado automáticamente el período ${fullName(targetYear, targetMonth)}. ` +
            `El período ${fullName(prevYear, prevMonth)} sigue abierto para tu revisión y cierre manual.`;
          const res = await sendNotificationEmail(
            a.email,
            `Nuevo período abierto: ${fullName(targetYear, targetMonth)}`,
            message,
            c.id,
          );
          if (res.success) emailed += 1;
          else emailFailures += 1;
        } catch (emailErr) {
          console.warn(
            `[cron/create-new-period] email to ${a.email} failed:`,
            emailErr,
          );
          emailFailures += 1;
        }
      }

      results.push({
        company_id: c.id,
        company_name: c.name,
        outcome: 'created',
        period_id: inserted.id as string,
        emailed,
        email_failures: emailFailures,
      });
    } catch (err) {
      results.push({
        company_id: c.id,
        company_name: c.name,
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const summary = {
    success: true,
    target: { year: targetYear, month: targetMonth, label: labelFor(targetYear, targetMonth) },
    dryRun,
    counts: {
      processed: results.length,
      created: results.filter((r) => r.outcome === 'created').length,
      skipped: results.filter((r) => r.outcome === 'skipped_exists').length,
      errors: results.filter((r) => r.outcome === 'error').length,
    },
    results,
  };

  return NextResponse.json(summary);
}
