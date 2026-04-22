// ─────────────────────────────────────────────────────────────────────────────
// /api/reports/config
//
// GET  → returns the caller's company report config (defaults if none).
// PUT  → admins update sections + cadences for their own company.
//
// Superadmins can operate on an explicit tenant via `?company_id=...`.
// All writes are logged in audit_logs so we can explain cron behaviour
// later ("why didn't I get the Monday report?").
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, verifySuperadminAuth } from '@/lib/api-auth';
import {
  loadReportConfig,
  saveReportConfig,
  DEFAULT_REPORT_CONFIG,
  type ReportSections,
  type ReportCadences,
  type CadenceDisabledUsers,
} from '@/lib/reports/config';
import { createAdminClient } from '@/lib/supabase/admin';

async function resolveCompanyAndAuth(
  explicitCompanyId: string | null,
): Promise<{ companyId: string; userId: string; isSuperadmin: boolean } | NextResponse> {
  if (explicitCompanyId) {
    const sa = await verifySuperadminAuth();
    if (sa instanceof NextResponse) return sa;
    return { companyId: explicitCompanyId, userId: sa.userId, isSuperadmin: true };
  }
  const auth = await verifyAdminAuth();
  if (auth instanceof NextResponse) return auth;
  if (auth.role !== 'admin') {
    return NextResponse.json(
      { success: false, error: 'Solo administradores pueden configurar los reportes' },
      { status: 403 },
    );
  }
  return { companyId: auth.companyId, userId: auth.userId, isSuperadmin: false };
}

export async function GET(request: NextRequest) {
  const explicit = request.nextUrl.searchParams.get('company_id');
  const resolved = await resolveCompanyAndAuth(explicit);
  if (resolved instanceof NextResponse) return resolved;

  const config = await loadReportConfig(resolved.companyId);
  return NextResponse.json({ success: true, config, defaults: DEFAULT_REPORT_CONFIG });
}

function isBoolRecord<T>(v: unknown, keys: (keyof T)[]): v is T {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return keys.every((k) => typeof o[k as string] === 'boolean');
}

export async function PUT(request: NextRequest) {
  const explicit = request.nextUrl.searchParams.get('company_id');
  const resolved = await resolveCompanyAndAuth(explicit);
  if (resolved instanceof NextResponse) return resolved;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'JSON inválido' }, { status: 400 });
  }
  const { sections, cadences, cadenceDisabledUsers } = (body ?? {}) as {
    sections?: unknown;
    cadences?: unknown;
    cadenceDisabledUsers?: unknown;
  };
  const sectionKeys: (keyof ReportSections)[] = [
    'deposits_withdrawals',
    'balances_by_channel',
    'crm_users',
    'broker_pnl',
    'prop_trading',
  ];
  const cadenceKeys: (keyof ReportCadences)[] = ['daily', 'weekly', 'monthly'];
  if (!isBoolRecord<ReportSections>(sections, sectionKeys)) {
    return NextResponse.json({ success: false, error: 'sections inválido' }, { status: 400 });
  }
  if (!isBoolRecord<ReportCadences>(cadences, cadenceKeys)) {
    return NextResponse.json({ success: false, error: 'cadences inválido' }, { status: 400 });
  }

  // Opt-out lists — optional. Accept only when each value is a string[].
  let disabledUsers: CadenceDisabledUsers | undefined;
  if (cadenceDisabledUsers && typeof cadenceDisabledUsers === 'object') {
    const raw = cadenceDisabledUsers as Record<string, unknown>;
    const coerce = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    disabledUsers = {
      daily: coerce(raw.daily),
      weekly: coerce(raw.weekly),
      monthly: coerce(raw.monthly),
    };
  }

  try {
    const config = await saveReportConfig({
      companyId: resolved.companyId,
      updatedBy: resolved.userId,
      sections,
      cadences,
      cadenceDisabledUsers: disabledUsers,
    });

    // Audit (best-effort).
    const admin = createAdminClient();
    await admin.from('audit_logs').insert({
      company_id: resolved.companyId,
      user_id: resolved.userId,
      action: 'update',
      module: 'reports_config',
      details: JSON.stringify({
        sections,
        cadences,
        cadenceDisabledUsers: disabledUsers,
        via_superadmin: resolved.isSuperadmin,
      }),
    });

    return NextResponse.json({ success: true, config });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Error' },
      { status: 500 },
    );
  }
}
