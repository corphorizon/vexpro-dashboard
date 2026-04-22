// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reports/send
//
// Manual report send triggered from /finanzas/reportes. Admin-only.
//
// Body:
//   {
//     from: "YYYY-MM-DD",
//     to:   "YYYY-MM-DD",
//     recipients: string[],              // email addresses
//     sections?: {                       // overrides the stored config
//       deposits_withdrawals: boolean,
//       crm_users: boolean,
//       broker_pnl: boolean,
//       prop_trading: boolean,
//     },
//     cadence?: 'daily' | 'weekly' | 'monthly',  // drives subject line
//     company_id?: string,               // superadmin only
//   }
//
// Reuses buildReportData + renderReportEmail + sendEmail. Every send writes
// an audit_logs row so admins can later trace "who sent what to whom".
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth, verifySuperadminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { buildReportData } from '@/lib/reports/data';
import {
  renderReportEmail,
  renderReportEmailText,
  reportEmailSubject,
  type ReportCadence,
} from '@/lib/reports/email-template';
import { sendEmail } from '@/services/emailService';
import { loadReportConfig } from '@/lib/reports/config';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface SendBody {
  from?: unknown;
  to?: unknown;
  recipients?: unknown;
  sections?: unknown;
  cadence?: unknown;
  company_id?: unknown;
}

export async function POST(request: NextRequest) {
  let body: SendBody;
  try {
    body = (await request.json()) as SendBody;
  } catch {
    return NextResponse.json({ success: false, error: 'JSON inválido' }, { status: 400 });
  }

  // Resolve caller + company.
  const explicit = typeof body.company_id === 'string' ? body.company_id : null;
  let companyId: string;
  let actorId: string;
  let actorName: string;
  let isSuperadmin = false;
  if (explicit) {
    const sa = await verifySuperadminAuth();
    if (sa instanceof NextResponse) return sa;
    companyId = explicit;
    actorId = sa.userId;
    actorName = sa.name || sa.email;
    isSuperadmin = true;
  } else {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;
    if (auth.role !== 'admin') {
      return NextResponse.json(
        { success: false, error: 'Solo administradores pueden enviar reportes' },
        { status: 403 },
      );
    }
    companyId = auth.companyId;
    actorId = auth.userId;
    actorName = auth.name || auth.email;
  }

  // Validate inputs.
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to) || from > to) {
    return NextResponse.json({ success: false, error: 'Rango de fechas inválido' }, { status: 400 });
  }
  const recipientsRaw = Array.isArray(body.recipients) ? body.recipients : [];
  const recipients: string[] = [];
  for (const r of recipientsRaw) {
    if (typeof r !== 'string') continue;
    const email = r.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) continue;
    if (!recipients.includes(email)) recipients.push(email);
  }
  if (recipients.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Se requiere al menos un destinatario válido' },
      { status: 400 },
    );
  }

  const cadence: ReportCadence =
    body.cadence === 'weekly' || body.cadence === 'monthly' ? body.cadence : 'daily';

  // Sections: use explicit override from body, else fall back to stored config.
  const storedCfg = await loadReportConfig(companyId);
  const sectionsBody = body.sections as
    | {
        deposits_withdrawals?: unknown;
        balances_by_channel?: unknown;
        crm_users?: unknown;
        broker_pnl?: unknown;
        prop_trading?: unknown;
      }
    | undefined;
  const sections = {
    deposits_withdrawals:
      typeof sectionsBody?.deposits_withdrawals === 'boolean'
        ? sectionsBody.deposits_withdrawals
        : storedCfg.sections.deposits_withdrawals,
    balances_by_channel:
      typeof sectionsBody?.balances_by_channel === 'boolean'
        ? sectionsBody.balances_by_channel
        : storedCfg.sections.balances_by_channel,
    crm_users:
      typeof sectionsBody?.crm_users === 'boolean'
        ? sectionsBody.crm_users
        : storedCfg.sections.crm_users,
    broker_pnl:
      typeof sectionsBody?.broker_pnl === 'boolean'
        ? sectionsBody.broker_pnl
        : storedCfg.sections.broker_pnl,
    prop_trading:
      typeof sectionsBody?.prop_trading === 'boolean'
        ? sectionsBody.prop_trading
        : storedCfg.sections.prop_trading,
  };

  // Look up company name / logo for the email header.
  const admin = createAdminClient();
  const { data: company } = await admin
    .from('companies')
    .select('id, name, logo_url, color_primary')
    .eq('id', companyId)
    .maybeSingle();
  if (!company) {
    return NextResponse.json({ success: false, error: 'Empresa no encontrada' }, { status: 404 });
  }

  // Build data + render email.
  const data = await buildReportData(companyId, from, to);
  const html = renderReportEmail({
    data,
    cadence,
    companyName: company.name,
    companyLogoUrl: company.logo_url,
    primaryColor: (company as { color_primary?: string | null }).color_primary,
    sections,
  });
  const text = renderReportEmailText({ data, cadence, companyName: company.name });
  const subject = reportEmailSubject({
    companyName: company.name,
    cadence,
    range: { from, to },
  });

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const email of recipients) {
    const res = await sendEmail(email, subject, html, text, companyId);
    if (res.success) sent += 1;
    else {
      failed += 1;
      errors.push(`${email}: ${res.error ?? 'error desconocido'}`);
    }
  }

  // Audit (best-effort).
  await admin.from('audit_logs').insert({
    company_id: companyId,
    user_id: actorId,
    user_name: actorName,
    action: 'export',
    module: 'reports_send',
    details: JSON.stringify({
      from,
      to,
      cadence,
      recipients,
      sections,
      sent,
      failed,
      via_superadmin: isSuperadmin,
    }),
  });

  return NextResponse.json({
    success: true,
    sent,
    failed,
    errors: errors.slice(0, 5),
  });
}
