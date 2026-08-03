import sgMail, { MailService } from '@sendgrid/mail';
import type { SendEmailResponse, LoginNotificationData } from '@/lib/types';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptSecret } from '@/lib/crypto';
import { et, type EmailLocale } from '@/lib/email-i18n';

// ---------------------------------------------------------------------------
// HTML escaping to prevent XSS in email templates
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// SendGrid credential resolution
//
// Priority:
//   1. Per-company credential from `api_credentials` (set via the admin
//      /configuraciones UI). Decrypted via API_CREDENTIALS_MASTER_KEY.
//   2. Fallback to env vars (SENDGRID_API_KEY / SENDGRID_FROM_EMAIL / NAME).
//
// Per-call config avoids stale global state when multiple companies send
// emails through the same serverless instance.
// ---------------------------------------------------------------------------

interface SendGridConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  source: 'db' | 'env';
}

async function getSendGridConfig(companyId?: string): Promise<SendGridConfig | null> {
  // 1. Try per-company DB credential first
  if (companyId) {
    try {
      const adminClient = createAdminClient();
      const { data } = await adminClient
        .from('api_credentials')
        .select('encrypted_secret, iv, auth_tag, extra_config')
        .eq('company_id', companyId)
        .eq('provider', 'sendgrid')
        .eq('is_configured', true)
        .maybeSingle();

      if (data) {
        const apiKey = decryptSecret({
          ciphertext: data.encrypted_secret,
          iv: data.iv,
          authTag: data.auth_tag,
        });
        const extra = (data.extra_config || {}) as Record<string, unknown>;
        return {
          apiKey,
          fromEmail: (extra.from_email as string) || process.env.SENDGRID_FROM_EMAIL || 'noreply@horizonconsulting.com',
          fromName: (extra.from_name as string) || process.env.SENDGRID_FROM_NAME || 'Horizon Consulting',
          source: 'db',
        };
      }
    } catch (err) {
      // If decryption or lookup fails, warn and fall through to env.
      console.warn('[EmailService] DB credential lookup failed, falling back to env:', err instanceof Error ? err.message : err);
    }
  }

  // 2. Env fallback
  const envKey = process.env.SENDGRID_API_KEY;
  if (!envKey || envKey === 'your_sendgrid_api_key_here') return null;
  return {
    apiKey: envKey,
    fromEmail: process.env.SENDGRID_FROM_EMAIL || 'noreply@horizonconsulting.com',
    fromName: process.env.SENDGRID_FROM_NAME || 'Horizon Consulting',
    source: 'env',
  };
}

// ---------------------------------------------------------------------------
// Base send function
//
// `companyId` is optional. When provided, uses per-company credentials;
// otherwise falls back to env. A fresh MailService instance is created per
// call so concurrent requests from different companies don't stomp on each
// other's API key in the shared `sgMail` singleton.
// ---------------------------------------------------------------------------

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text?: string,
  companyId?: string,
): Promise<SendEmailResponse> {
  const config = await getSendGridConfig(companyId);
  if (!config) {
    const error = 'SendGrid is not configured for this company or environment';
    console.error(`[EmailService] ${error}`);
    return { success: false, error };
  }

  try {
    const client = new MailService();
    client.setApiKey(config.apiKey);

    const msg: sgMail.MailDataRequired = {
      to,
      from: { email: config.fromEmail, name: config.fromName },
      subject,
      html,
      ...(text ? { text } : {}),
    };

    const [response] = await client.send(msg);
    const messageId = response?.headers?.['x-message-id'] ?? undefined;

    console.log(`[EmailService] Email sent to ${to} via ${config.source} — "${subject}"`);
    return { success: true, messageId };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error sending email';
    console.error(`[EmailService] Failed to send email to ${to}:`, message);
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Specialized email functions. All accept optional companyId to look up
// per-company SendGrid credentials; omit for env-only defaults.
//
// Every function also takes a final optional `locale` ('en' | 'es', default
// 'en') — subject/HTML/text are built via et() so the recipient gets the
// email in their configured language. Callers resolve the locale with
// resolveUserLocale() from @/lib/email-i18n.
// ---------------------------------------------------------------------------

export async function sendWelcomeEmail(
  to: string,
  userName: string,
  companyId?: string,
  locale: EmailLocale = 'en',
): Promise<SendEmailResponse> {
  const subject = et(locale, 'welcome.subject');
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">${et(locale, 'welcome.title')}</h2>
      <p>${et(locale, 'common.hi')} <strong>${escapeHtml(userName)}</strong>,</p>
      <p>${et(locale, 'welcome.body')}</p>
      <p>${et(locale, 'welcome.contact')}</p>
      <br/>
      <p style="color: #666; font-size: 12px;">${et(locale, 'common.signature')}</p>
    </div>
  `;
  const text = et(locale, 'welcome.text', { name: userName });
  return sendEmail(to, subject, html, text, companyId);
}

export async function sendPasswordResetEmail(
  to: string,
  resetLink: string,
  companyId?: string,
  locale: EmailLocale = 'en',
): Promise<SendEmailResponse> {
  const subject = et(locale, 'reset.subject');
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">${et(locale, 'reset.title')}</h2>
      <p>${et(locale, 'reset.intro')}</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${escapeHtml(resetLink)}" style="background-color: #1a1a2e; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          ${et(locale, 'reset.button')}
        </a>
      </p>
      <p style="color: #666; font-size: 13px;">${et(locale, 'reset.ignore')}</p>
      <br/>
      <p style="color: #666; font-size: 12px;">${et(locale, 'common.signature')}</p>
    </div>
  `;
  const text = et(locale, 'reset.text', { link: resetLink });
  return sendEmail(to, subject, html, text, companyId);
}

export async function sendDashboardReportEmail(
  to: string,
  reportName: string,
  reportPeriod: string,
  reportSummary: string,
  companyId?: string,
  locale: EmailLocale = 'en',
): Promise<SendEmailResponse> {
  const subject = et(locale, 'dreport.subject', { name: reportName, period: reportPeriod });
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">${et(locale, 'dreport.title')}</h2>
      <p><strong>${et(locale, 'dreport.reportLabel')}</strong> ${escapeHtml(reportName)}</p>
      <p><strong>${et(locale, 'dreport.periodLabel')}</strong> ${escapeHtml(reportPeriod)}</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <div>${escapeHtml(reportSummary)}</div>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="color: #666; font-size: 13px;">${et(locale, 'dreport.footer')}</p>
      <br/>
      <p style="color: #666; font-size: 12px;">${et(locale, 'common.signature')}</p>
    </div>
  `;
  const text = `${et(locale, 'dreport.textTitle', { name: reportName, period: reportPeriod })}\n\n${reportSummary}`;
  return sendEmail(to, subject, html, text, companyId);
}

export async function sendTwofaResetCodeEmail(params: {
  to: string;
  userName: string;
  code: string;
  expiresInMinutes?: number;
  companyId?: string;
  locale?: EmailLocale;
}): Promise<SendEmailResponse> {
  const { to, userName, code, expiresInMinutes = 15, companyId, locale = 'en' } = params;
  const safeName = escapeHtml(userName);
  const safeCode = escapeHtml(code);
  const subject = et(locale, 'twofa.subject');
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h2 style="color: #1a1a2e;">${et(locale, 'twofa.title')}</h2>
      <p>${et(locale, 'common.hi')} <strong>${safeName}</strong>,</p>
      <p>${et(locale, 'twofa.intro', { minutes: expiresInMinutes })}</p>
      <div style="margin: 24px 0; padding: 16px; background: #f1f5f9; border-radius: 8px; text-align: center;">
        <code style="font-size: 32px; letter-spacing: 8px; font-weight: 700; color: #0f172a;">${safeCode}</code>
      </div>
      <p style="color: #64748b; font-size: 13px;">
        ${et(locale, 'twofa.ignore')}
      </p>
      <p style="color: #666; font-size: 12px;">${et(locale, 'common.signature')}</p>
    </div>
  `;
  const text = et(locale, 'twofa.text', { code, minutes: expiresInMinutes });
  return sendEmail(to, subject, html, text, companyId);
}

export async function sendNotificationEmail(
  to: string,
  title: string,
  message: string,
  companyId?: string,
  locale: EmailLocale = 'en',
): Promise<SendEmailResponse> {
  const subject = et(locale, 'notif.subject', { title });
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <br/>
      <p style="color: #666; font-size: 12px;">${et(locale, 'common.signature')}</p>
    </div>
  `;
  const text = `${title}\n\n${message}`;
  return sendEmail(to, subject, html, text, companyId);
}

export async function sendLoginNotificationEmail(
  to: string,
  userName: string,
  details: Omit<LoginNotificationData, 'userName'>,
  companyId?: string,
  locale: EmailLocale = 'en',
): Promise<SendEmailResponse> {
  const { loginDate, loginTime, browser, ipAddress, dashboardUrl } = details;

  const subject = et(locale, 'login.subject');
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 20px;">
      <!-- Header -->
      <div style="background-color: #1a1a2e; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 20px;">Smart Dashboard</h1>
        <p style="color: #a0aec0; margin: 4px 0 0; font-size: 13px;">Horizon Consulting</p>
      </div>

      <!-- Body -->
      <div style="background-color: #ffffff; padding: 32px 24px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; color: #1a1a2e;">${et(locale, 'common.hi')} <strong>${escapeHtml(userName)}</strong>,</p>
        <p style="font-size: 14px; color: #4a5568; line-height: 1.6;">
          ${et(locale, 'login.intro')}
        </p>

        <!-- Login details card -->
        <div style="background-color: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #718096; font-size: 13px; width: 120px;">${et(locale, 'login.date')}</td>
              <td style="padding: 8px 0; color: #1a202c; font-size: 14px; font-weight: 600;">${loginDate}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #718096; font-size: 13px;">${et(locale, 'login.time')}</td>
              <td style="padding: 8px 0; color: #1a202c; font-size: 14px; font-weight: 600;">${loginTime}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #718096; font-size: 13px;">${et(locale, 'login.device')}</td>
              <td style="padding: 8px 0; color: #1a202c; font-size: 14px; font-weight: 600;">${browser}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #718096; font-size: 13px;">${et(locale, 'login.ip')}</td>
              <td style="padding: 8px 0; color: #1a202c; font-size: 14px; font-weight: 600;">${ipAddress}</td>
            </tr>
          </table>
        </div>

        <!-- Warning banner -->
        <div style="background-color: #fffbeb; border: 1px solid #fbbf24; border-radius: 6px; padding: 16px; margin: 24px 0;">
          <p style="margin: 0; font-size: 14px; color: #92400e; line-height: 1.5;">
            <strong>${et(locale, 'login.wasYou')}</strong> ${et(locale, 'login.warning')}
          </p>
        </div>

        <!-- CTA Button -->
        <p style="text-align: center; margin: 28px 0;">
          <a href="${dashboardUrl}/perfil"
             style="background-color: #dc2626; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block;">
            ${et(locale, 'login.cta')}
          </a>
        </p>

        <p style="font-size: 12px; color: #a0aec0; text-align: center;">
          ${et(locale, 'login.noAction')}
        </p>
      </div>

      <!-- Footer -->
      <p style="color: #a0aec0; font-size: 11px; text-align: center; margin-top: 16px;">
        &copy; Horizon Consulting — Smart Dashboard
      </p>
    </div>
  `;

  const text = [
    `${et(locale, 'common.hi')} ${userName},`,
    et(locale, 'login.textIntro'),
    `${et(locale, 'login.date')}: ${loginDate}`,
    `${et(locale, 'login.time')}: ${loginTime}`,
    `${et(locale, 'login.device')}: ${browser}`,
    `${et(locale, 'login.ip')}: ${ipAddress}`,
    et(locale, 'login.textAction', { url: `${dashboardUrl}/perfil` }),
  ].join('\n');

  return sendEmail(to, subject, html, text, companyId);
}

// ─────────────────────────────────────────────────────────────────────────────
// sendInviteEmail
//
// Invitación de usuario nuevo. Reemplaza al `inviteUserByEmail` de Supabase
// (que mandaba un template genérico apuntando a /login sin password). Acá
// el link va a /reset-password?token=...&mode=setup, donde la página ya
// soporta el flujo de "primera contraseña" tras el flag mode=setup.
//
// Bilingüe: el texto español original se preserva como variante 'es'; la
// variante 'en' es la default (usuarios nuevos → inglés).
// ─────────────────────────────────────────────────────────────────────────────
export async function sendInviteEmail(
  to: string,
  setupLink: string,
  inviterName: string,
  companyName: string,
  recipientName: string,
  expiresInHours: number = 24,
  companyId?: string,
  locale: EmailLocale = 'en',
): Promise<SendEmailResponse> {
  const safeRecipient = escapeHtml(recipientName);
  const safeInviter = escapeHtml(inviterName);
  const safeCompany = escapeHtml(companyName);
  const safeLink = escapeHtml(setupLink);

  const subject = et(locale, 'invite.subject', { company: companyName });

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 20px;">
      <div style="background-color: #1a1a2e; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 22px;">${et(locale, 'invite.headerTitle', { company: safeCompany })}</h1>
        <p style="color: #a0aec0; margin: 6px 0 0; font-size: 13px;">Smart Dashboard · Horizon Consulting</p>
      </div>

      <div style="background-color: #ffffff; padding: 32px 24px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; color: #1a1a2e;">${et(locale, 'common.hi')} <strong>${safeRecipient}</strong>,</p>
        <p style="font-size: 14px; color: #4a5568; line-height: 1.6;">
          ${et(locale, 'invite.body', { inviter: safeInviter, company: safeCompany })}
        </p>

        <p style="text-align: center; margin: 32px 0;">
          <a href="${safeLink}"
             style="background-color: #1a1a2e; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 15px; display: inline-block;">
            ${et(locale, 'invite.button')}
          </a>
        </p>

        <div style="background-color: #f7fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 14px 18px; margin: 24px 0;">
          <p style="margin: 0; font-size: 13px; color: #4a5568; line-height: 1.5;">
            <strong>📌 ${et(locale, 'invite.important')}</strong> ${et(locale, 'invite.expires', { hours: expiresInHours })}
          </p>
        </div>

        <p style="font-size: 12px; color: #a0aec0; line-height: 1.6;">
          ${et(locale, 'invite.ignore', { inviter: safeInviter })}
        </p>

        <p style="font-size: 12px; color: #a0aec0; word-break: break-all;">
          ${et(locale, 'invite.fallback')}<br/>
          ${safeLink}
        </p>
      </div>

      <p style="color: #a0aec0; font-size: 11px; text-align: center; margin-top: 16px;">
        &copy; Horizon Consulting — Smart Dashboard
      </p>
    </div>
  `;

  const text = [
    `${et(locale, 'common.hi')} ${recipientName},`,
    ``,
    et(locale, 'invite.textBody', { inviter: inviterName, company: companyName }),
    ``,
    et(locale, 'invite.textLink', { link: setupLink }),
    ``,
    et(locale, 'invite.textExpires', { hours: expiresInHours }),
    ``,
    et(locale, 'common.signature'),
  ].join('\n');

  return sendEmail(to, subject, html, text, companyId);
}
