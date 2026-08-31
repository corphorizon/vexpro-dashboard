// ─────────────────────────────────────────────────────────────────────────────
// Reports cron orchestrator.
//
// One function per cadence. Each one:
//   1. Finds every ACTIVE company that has 'reports' in active_modules.
//   2. For each tenant, finds every user with 'reports' in allowed_modules
//      AND status='active' — these are the recipients.
//   3. Builds the report data + HTML for that tenant.
//   4. Sends one email per recipient via emailService.sendEmail
//      (per-tenant SendGrid creds when configured, env fallback otherwise).
//   5. Records a row in audit_logs summarising what was sent.
//
// Designed to survive partial failures — if one tenant blows up, the rest
// still go out. Each call returns a summary object that the cron route
// ships back to Vercel for log inspection.
// ─────────────────────────────────────────────────────────────────────────────

import { createAdminClient } from '@/lib/supabase/admin';
import { sendEmail } from '@/services/emailService';
import { isEmailLocale, type EmailLocale } from '@/lib/email-i18n';
import { serverAuditLog } from '@/lib/server-audit';
import { buildReportData, referenceDateFor } from './data';
import { loadReportConfig } from './config';
import {
  renderReportEmail,
  renderReportEmailText,
  reportEmailSubject,
  type ReportCadence,
} from './email-template';

export interface SendReportsResult {
  cadence: ReportCadence;
  range: { from: string; to: string };
  tenants_processed: number;
  emails_sent: number;
  emails_failed: number;
  details: Array<{
    company_id: string;
    company_name: string;
    recipients: number;
    sent: number;
    failed: number;
    error?: string;
  }>;
}

interface CompanyRow {
  id: string;
  name: string;
  logo_url: string | null;
  color_primary: string | null;
  active_modules: string[];
  status: string;
}
interface UserRow {
  id: string;
  user_id: string;
  email: string;
  name: string;
  allowed_modules: string[];
  status: string;
  preferred_language?: string | null;
}

/**
 * Returns {from, to} for the day BEFORE referenceDate (00:00 → 23:59 UTC).
 * Used by the daily cron: runs at 00:05 UTC → reports on yesterday.
 */
export function previousDayRange(referenceDate: Date = new Date()): {
  from: string;
  to: string;
} {
  const y = new Date(referenceDate);
  y.setUTCDate(y.getUTCDate() - 1);
  const iso = y.toISOString().slice(0, 10);
  return { from: iso, to: iso };
}

/**
 * Returns {from, to} for the 7 days BEFORE referenceDate.
 * The weekly cron runs Mondays at 00:05 UTC → reports on Mon→Sun of the
 * previous week.
 */
export function previousWeekRange(referenceDate: Date = new Date()): {
  from: string;
  to: string;
} {
  const end = new Date(referenceDate);
  end.setUTCDate(end.getUTCDate() - 1); // Sunday
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6); // Monday of that week
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

/**
 * Returns {from, to} for the full previous calendar month.
 * Monthly cron runs on the 1st at 00:05 UTC → reports on the prior month.
 */
export function previousMonthRange(referenceDate: Date = new Date()): {
  from: string;
  to: string;
} {
  const pad = (n: number) => String(n).padStart(2, '0');
  const prev = new Date(
    Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() - 1, 1),
  );
  const lastDay = new Date(
    Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return {
    from: `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-01`,
    to: `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(lastDay)}`,
  };
}

/**
 * Core orchestrator — generate + send reports to every eligible tenant.
 *
 * @param cadence which subject line / template variant to use.
 * @param range   { from, to } — date range the report covers.
 * @param options.dryRun        don't actually send emails, just return
 *                              what would be sent. Used by manual test
 *                              runs that want to verify the pipeline
 *                              without spamming recipients.
 * @param options.onlyCompanyId limit to one tenant (manual trigger).
 */
export async function sendReportsForCadence(
  cadence: ReportCadence,
  range: { from: string; to: string },
  options: {
    dryRun?: boolean;
    onlyCompanyId?: string;
    /** ISO timestamp of the last successful external-API sync. Rendered
     *  as a small footer note in the email so readers can see how fresh
     *  the data is. */
    lastSyncedAt?: string | null;
  } = {},
): Promise<SendReportsResult> {
  const admin = createAdminClient();

  const { data: companies, error: companiesError } = await admin
    .from('companies')
    .select('id, name, logo_url, color_primary, active_modules, status')
    .eq('status', 'active');

  if (companiesError || !companies) {
    throw new Error(`Could not list companies: ${companiesError?.message ?? 'unknown'}`);
  }

  const eligible = (companies as CompanyRow[]).filter((c) => {
    if (options.onlyCompanyId && c.id !== options.onlyCompanyId) return false;
    return Array.isArray(c.active_modules) && c.active_modules.includes('reports');
  });

  // Superadmins de plataforma (pedido Kevin 2026-08-08): reciben el reporte
  // de TODAS las empresas — supervisan el grupo entero y no viven en
  // company_users, así que el filtro por tenant nunca los alcanzaba. Se
  // consultan una sola vez y se suman a cada empresa, deduplicados por email.
  const { data: platformRows } = await admin
    .from('platform_users')
    .select('id, user_id, email, name, preferred_language');
  const superadmins = ((platformRows ?? []) as Array<{
    id: string; user_id: string; email: string | null; name: string | null;
    preferred_language: string | null;
  }>)
    .filter((p): p is typeof p & { email: string } => !!p.email)
    .map((p) => ({
      id: p.id,
      user_id: p.user_id,
      email: p.email,
      name: p.name ?? p.email,
      allowed_modules: ['reports'],
      status: 'active',
      preferred_language: p.preferred_language,
    }));

  const details: SendReportsResult['details'] = [];
  let emails_sent = 0;
  let emails_failed = 0;

  for (const company of eligible) {
    const entry: SendReportsResult['details'][number] = {
      company_id: company.id,
      company_name: company.name,
      recipients: 0,
      sent: 0,
      failed: 0,
    };

    try {
      // Respect the per-company report config: if this cadence is disabled
      // we skip the tenant entirely. Manual (onlyCompanyId) runs bypass the
      // cadence gate — admins triggering a send already made that choice.
      const cfg = await loadReportConfig(company.id);
      if (!options.onlyCompanyId) {
        const cadenceOn =
          (cadence === 'daily' && cfg.cadences.daily) ||
          (cadence === 'weekly' && cfg.cadences.weekly) ||
          (cadence === 'monthly' && cfg.cadences.monthly);
        if (!cadenceOn) {
          details.push(entry);
          continue;
        }
      }

      // Recipients: users of this tenant with 'reports' in allowed_modules
      // and not deactivated.
      const { data: users, error: usersError } = await admin
        .from('company_users')
        .select('id, user_id, email, name, allowed_modules, status, preferred_language')
        .eq('company_id', company.id);
      if (usersError) throw new Error(usersError.message);

      // Finanzas access = reports OR movements module. Matches
      // /api/reports/recipients so the admin panel and cron agree on who's
      // a candidate.
      const FINANZAS_MODULES = ['reports', 'movements'];
      const optedOut = new Set(cfg.cadenceDisabledUsers?.[cadence] ?? []);
      const recipients = (users ?? [] as UserRow[]).filter(
        (u) =>
          u.status !== 'inactive' &&
          !!u.email &&
          Array.isArray(u.allowed_modules) &&
          u.allowed_modules.some((m) => FINANZAS_MODULES.includes(m)) &&
          !optedOut.has(u.id),
      );

      // Superadmins al final, deduplicados por email por si alguno también
      // existiera como usuario del tenant. El opt-out por cadencia les aplica
      // igual (su id de platform_users puede entrar en cadenceDisabledUsers).
      const tenantEmails = new Set(recipients.map((r) => (r.email ?? '').toLowerCase()));
      for (const sa of superadmins) {
        if (optedOut.has(sa.id)) continue;
        if (tenantEmails.has((sa.email ?? '').toLowerCase())) continue;
        recipients.push(sa);
      }
      entry.recipients = recipients.length;

      if (recipients.length === 0) {
        entry.sent = 0;
        details.push(entry);
        continue;
      }

      // Build data once per tenant, then render once per locale group —
      // recipients get the email in their preferred_language ('en' when
      // absent) without re-rendering per recipient.
      // `referenceDateFor(range.to)` y NO el default (= hoy): el cron diario
      // del día 1 informa el último día del mes anterior, y con la fecha de
      // hoy «este mes» resolvía al mes recién nacido — KPI del mes en casi
      // cero en el correo del cierre. Para el diario «ayer» es `range.to`;
      // para el semanal, el domingo que cierra la semana; para el mensual,
      // el último día del mes informado. En los tres, `range.to`.
      const data = await buildReportData(
        company.id, range.from, range.to, referenceDateFor(range.to),
      );

      const byLocale = new Map<EmailLocale, UserRow[]>();
      for (const r of recipients) {
        const locale: EmailLocale = isEmailLocale(r.preferred_language)
          ? r.preferred_language
          : 'en';
        const group = byLocale.get(locale);
        if (group) group.push(r);
        else byLocale.set(locale, [r]);
      }

      for (const [locale, group] of byLocale) {
        const html = renderReportEmail({
          data,
          cadence,
          companyName: company.name,
          companyLogoUrl: company.logo_url,
          primaryColor: company.color_primary,
          sections: cfg.sections,
          lastSyncedAt: options.lastSyncedAt ?? null,
          locale,
        });
        const text = renderReportEmailText({
          data,
          cadence,
          companyName: company.name,
          // Mismas secciones que el HTML: cfg.sections ya trae aplicado
          // blockedReportSections (loadReportConfig lo filtra en lectura).
          sections: cfg.sections,
          locale,
        });
        const subject = reportEmailSubject({
          companyName: company.name,
          cadence,
          range,
          locale,
        });

        for (const r of group) {
          if (options.dryRun) {
            entry.sent += 1;
            emails_sent += 1;
            continue;
          }
          const res = await sendEmail(r.email, subject, html, text, company.id);
          if (res.success) {
            entry.sent += 1;
            emails_sent += 1;
          } else {
            entry.failed += 1;
            emails_failed += 1;
          }
        }
      }

      // Audit once per tenant — "sent N reports to M recipients".
      await serverAuditLog(admin, {
        companyId: company.id,
        actorId: '00000000-0000-0000-0000-000000000000', // system
        actorName: 'cron',
        action: 'export',
        module: 'finance',
        details: `Reporte ${cadence} (${range.from} → ${range.to}) — ${entry.sent}/${entry.recipients} emails enviados${entry.failed > 0 ? `, ${entry.failed} fallos` : ''}${options.dryRun ? ' [dry run]' : ''}`,
      });
    } catch (err) {
      entry.error = err instanceof Error ? err.message : 'unknown error';
      emails_failed += entry.recipients; // worst-case counter
      console.error(`[reports/send] tenant ${company.name} failed:`, err);
    }

    details.push(entry);
  }

  return {
    cadence,
    range,
    tenants_processed: eligible.length,
    emails_sent,
    emails_failed,
    details,
  };
}
