// One-off: manda el reporte de una fecha SOLO a los superadmin de plataforma.
// Uso: npx tsx scripts/send-report-superadmins.ts 2026-08-07
// No toca a los destinatarios normales — es para pruebas/reenvíos puntuales.

import { readFileSync } from 'fs';
import { resolve } from 'path';

// .env.local a mano: este script corre fuera de Next.
for (const line of readFileSync(resolve(process.cwd(), '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

async function main() {
  const day = process.argv[2];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) {
    console.error('Uso: npx tsx scripts/send-report-superadmins.ts YYYY-MM-DD');
    process.exit(1);
  }
  const range = { from: day, to: day };

  const { createAdminClient } = await import('@/lib/supabase/admin');
  const { buildReportData } = await import('@/lib/reports/data');
  const { loadReportConfig } = await import('@/lib/reports/config');
  const { renderReportEmail, renderReportEmailText, reportEmailSubject } = await import('@/lib/reports/email-template');
  const { sendEmail } = await import('@/services/emailService');
  const { isEmailLocale } = await import('@/lib/email-i18n');

  const admin = createAdminClient();

  const { data: sas } = await admin.from('platform_users').select('email, name, preferred_language');
  const superadmins = (sas ?? []).filter((s) => !!s.email);
  console.log('Superadmins:', superadmins.map((s) => s.email).join(', '));

  const { data: companies } = await admin
    .from('companies')
    .select('id, name, logo_url, color_primary, active_modules, status')
    .eq('status', 'active');

  for (const company of companies ?? []) {
    if (!Array.isArray(company.active_modules) || !company.active_modules.includes('reports')) continue;
    const cfg = await loadReportConfig(company.id);
    const data = await buildReportData(company.id, range.from, range.to);

    for (const sa of superadmins) {
      const locale = isEmailLocale(sa.preferred_language) ? sa.preferred_language : 'en';
      const html = renderReportEmail({
        data, cadence: 'daily', companyName: company.name,
        companyLogoUrl: company.logo_url, primaryColor: company.color_primary,
        sections: cfg.sections, lastSyncedAt: null, locale,
      });
      const text = renderReportEmailText({ data, cadence: 'daily', companyName: company.name, locale });
      const subject = reportEmailSubject({ companyName: company.name, cadence: 'daily', range, locale });
      const res = await sendEmail(sa.email as string, subject, html, text, company.id);
      console.log(`${company.name} → ${sa.email}: ${res.success ? 'ENVIADO' : `FALLÓ (${res.error ?? '?'})`}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
