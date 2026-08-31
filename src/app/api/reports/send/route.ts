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
import { buildReportData, referenceDateFor } from '@/lib/reports/data';
import {
  renderReportEmail,
  renderReportEmailText,
  reportEmailSubject,
  type ReportCadence,
} from '@/lib/reports/email-template';
import { sendEmail } from '@/services/emailService';
import { loadReportConfig } from '@/lib/reports/config';
import { blockedReportSections } from '@/lib/business-model';
import { resolveUserLocale, type EmailLocale } from '@/lib/email-i18n';

// Un envío legítimo no necesita más de 50 destinatarios; el tope es una barrera
// defensiva contra un body inflado, no un límite de producto.
const MAX_RECIPIENTS = 50;

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
    const auth = await verifyAdminAuth(undefined, { modules: ['reports'] });
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

  const admin = createAdminClient();

  // ── Blindaje anti-exfiltración ──────────────────────────────────────────
  // El body solo validaba SINTAXIS de email, así que un admin podía mandarse
  // el reporte financiero a cualquier correo. Acá se filtra contra el conjunto
  // legítimo: los usuarios de ESTA empresa (company_users) + los superadmins de
  // plataforma (platform_users). Cualquier correo fuera de ese set se descarta
  // (con log) en vez de enviarse.
  const [companyUsersRes, platformUsersRes] = await Promise.all([
    admin.from('company_users').select('email').eq('company_id', companyId),
    admin.from('platform_users').select('email'),
  ]);
  const allowedEmails = new Set<string>();
  for (const row of (companyUsersRes.data ?? []) as Array<{ email: string | null }>) {
    if (row.email) allowedEmails.add(row.email.trim().toLowerCase());
  }
  for (const row of (platformUsersRes.data ?? []) as Array<{ email: string | null }>) {
    if (row.email) allowedEmails.add(row.email.trim().toLowerCase());
  }

  const rejected: string[] = [];
  const legitRecipients = recipients.filter((email) => {
    if (allowedEmails.has(email)) return true;
    rejected.push(email);
    return false;
  });
  if (rejected.length > 0) {
    console.warn(
      `[reports/send] destinatarios descartados por no pertenecer a la empresa ${companyId}: ${rejected.join(', ')}`,
    );
  }
  if (legitRecipients.length === 0) {
    // Mensaje seguro: no revela qué correos existen ni por qué se filtraron.
    return NextResponse.json(
      { success: false, error: 'Ningún destinatario válido para esta empresa' },
      { status: 400 },
    );
  }
  const finalRecipients = legitRecipients.slice(0, MAX_RECIPIENTS);

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

  // Look up company name / logo / modelo de negocio for the email header.
  const { data: company } = await admin
    .from('companies')
    .select('id, name, logo_url, color_primary, business_model')
    .eq('id', companyId)
    .maybeSingle();
  if (!company) {
    return NextResponse.json({ success: false, error: 'Empresa no encontrada' }, { status: 404 });
  }

  // El modelo de negocio manda sobre el body: loadReportConfig ya filtra las
  // secciones bloqueadas en LECTURA, pero body.sections gana sobre la config y
  // podría re-encender una sección que el modelo no admite (p. ej. mandarle
  // "Depósitos y retiros" a una empresa 'company'). Se vuelven a apagar acá,
  // en el servidor, como último control.
  for (const key of blockedReportSections(company.business_model)) {
    if (key in sections) sections[key as keyof typeof sections] = false;
  }

  // Build data once, then render lazily per recipient locale ('en' when the
  // recipient has no configured preference) — one render per language, not
  // per recipient.
  // El mes de contexto es el del último día informado, no el de hoy: un envío
  // manual de «el mes pasado» hecho hoy tiene que comparar contra ese mes.
  const data = await buildReportData(companyId, from, to, referenceDateFor(to));
  const rendered = new Map<EmailLocale, { html: string; text: string; subject: string }>();
  const renderFor = (locale: EmailLocale) => {
    const cached = rendered.get(locale);
    if (cached) return cached;
    const r = {
      html: renderReportEmail({
        data,
        cadence,
        companyName: company.name,
        companyLogoUrl: company.logo_url,
        primaryColor: (company as { color_primary?: string | null }).color_primary,
        sections,
        locale,
      }),
      text: renderReportEmailText({ data, cadence, companyName: company.name, sections, locale }),
      subject: reportEmailSubject({
        companyName: company.name,
        cadence,
        range: { from, to },
        locale,
      }),
    };
    rendered.set(locale, r);
    return r;
  };

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const email of finalRecipients) {
    const locale = await resolveUserLocale(admin, email);
    const { html, text, subject } = renderFor(locale);
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
      recipients: finalRecipients,
      rejected,
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
