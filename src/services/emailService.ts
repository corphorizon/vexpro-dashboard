import sgMail from '@sendgrid/mail';
import type { SendEmailResponse, LoginNotificationData } from '@/lib/types';

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
// SendGrid initialization
// ---------------------------------------------------------------------------

let initialized = false;

function initSendGrid(): void {
  if (initialized) return;

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey || apiKey === 'your_sendgrid_api_key_here') {
    console.warn('[EmailService] SENDGRID_API_KEY is not configured');
    return;
  }

  sgMail.setApiKey(apiKey);
  initialized = true;
}

function getFromAddress(): { email: string; name: string } {
  return {
    email: process.env.SENDGRID_FROM_EMAIL || 'noreply@horizonconsulting.com',
    name: process.env.SENDGRID_FROM_NAME || 'Horizon Consulting',
  };
}

// ---------------------------------------------------------------------------
// Base send function
// ---------------------------------------------------------------------------

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text?: string,
): Promise<SendEmailResponse> {
  initSendGrid();

  if (!initialized) {
    const error = 'SendGrid is not configured. Set SENDGRID_API_KEY in .env.local';
    console.error(`[EmailService] ${error}`);
    return { success: false, error };
  }

  try {
    const from = getFromAddress();
    const msg: sgMail.MailDataRequired = {
      to,
      from,
      subject,
      html,
      ...(text ? { text } : {}),
    };

    const [response] = await sgMail.send(msg);
    const messageId = response?.headers?.['x-message-id'] ?? undefined;

    console.log(`[EmailService] Email sent to ${to} — subject: "${subject}"`);
    return { success: true, messageId };
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Unknown error sending email';

    console.error(`[EmailService] Failed to send email to ${to}:`, message);
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Specialized email functions
// ---------------------------------------------------------------------------

export async function sendWelcomeEmail(
  to: string,
  userName: string,
): Promise<SendEmailResponse> {
  const subject = 'Welcome to Smart Dashboard — Horizon Consulting';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">Welcome to Smart Dashboard</h2>
      <p>Hi <strong>${escapeHtml(userName)}</strong>,</p>
      <p>Your account has been created successfully. You can now access the Smart Dashboard to view financial reports, manage operations, and collaborate with your team.</p>
      <p>If you have any questions, please contact your administrator.</p>
      <br/>
      <p style="color: #666; font-size: 12px;">— Horizon Consulting</p>
    </div>
  `;
  const text = `Welcome to Smart Dashboard, ${userName}! Your account has been created successfully.`;

  return sendEmail(to, subject, html, text);
}

export async function sendPasswordResetEmail(
  to: string,
  resetLink: string,
): Promise<SendEmailResponse> {
  const subject = 'Reset your password — Smart Dashboard';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">Password Reset Request</h2>
      <p>We received a request to reset your password. Click the button below to set a new password:</p>
      <p style="text-align: center; margin: 30px 0;">
        <a href="${escapeHtml(resetLink)}" style="background-color: #1a1a2e; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
          Reset Password
        </a>
      </p>
      <p style="color: #666; font-size: 13px;">If you did not request this, you can safely ignore this email. This link expires in 1 hour.</p>
      <br/>
      <p style="color: #666; font-size: 12px;">— Horizon Consulting</p>
    </div>
  `;
  const text = `Reset your password by visiting: ${resetLink}. If you did not request this, ignore this email.`;

  return sendEmail(to, subject, html, text);
}

export async function sendDashboardReportEmail(
  to: string,
  reportName: string,
  reportPeriod: string,
  reportSummary: string,
): Promise<SendEmailResponse> {
  const subject = `Financial Report: ${reportName} — ${reportPeriod}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">Financial Report</h2>
      <p><strong>Report:</strong> ${escapeHtml(reportName)}</p>
      <p><strong>Period:</strong> ${escapeHtml(reportPeriod)}</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <div>${escapeHtml(reportSummary)}</div>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
      <p style="color: #666; font-size: 13px;">Log in to Smart Dashboard for the full report and interactive charts.</p>
      <br/>
      <p style="color: #666; font-size: 12px;">— Horizon Consulting</p>
    </div>
  `;
  const text = `Financial Report: ${reportName} — ${reportPeriod}\n\n${reportSummary}`;

  return sendEmail(to, subject, html, text);
}

export async function sendNotificationEmail(
  to: string,
  title: string,
  message: string,
): Promise<SendEmailResponse> {
  const subject = `Smart Dashboard Alert: ${title}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a2e;">${escapeHtml(title)}</h2>
      <p>${escapeHtml(message)}</p>
      <br/>
      <p style="color: #666; font-size: 12px;">— Horizon Consulting</p>
    </div>
  `;
  const text = `${title}\n\n${message}`;

  return sendEmail(to, subject, html, text);
}

export async function sendLoginNotificationEmail(
  to: string,
  userName: string,
  details: Omit<LoginNotificationData, 'userName'>,
): Promise<SendEmailResponse> {
  const { loginDate, loginTime, browser, ipAddress, dashboardUrl } = details;

  const subject = 'New sign-in to your Horizon Consulting account';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #f9fafb; padding: 20px;">
      <!-- Header -->
      <div style="background-color: #1a1a2e; padding: 24px; border-radius: 8px 8px 0 0; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 20px;">Smart Dashboard</h1>
        <p style="color: #a0aec0; margin: 4px 0 0; font-size: 13px;">Horizon Consulting</p>
      </div>

      <!-- Body -->
      <div style="background-color: #ffffff; padding: 32px 24px; border-radius: 0 0 8px 8px;">
        <p style="font-size: 16px; color: #1a1a2e;">Hi <strong>${escapeHtml(userName)}</strong>,</p>
        <p style="font-size: 14px; color: #4a5568; line-height: 1.6;">
          We detected a new sign-in to your Smart Dashboard account. Here are the details:
        </p>

        <!-- Login details card -->
        <div style="background-color: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; color: #718096; font-size: 13px; width: 120px;">Date</td>
              <td style="padding: 8px 0; color: #1a202c; font-size: 14px; font-weight: 600;">${loginDate}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #718096; font-size: 13px;">Time</td>
              <td style="padding: 8px 0; color: #1a202c; font-size: 14px; font-weight: 600;">${loginTime}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #718096; font-size: 13px;">Device / Browser</td>
              <td style="padding: 8px 0; color: #1a202c; font-size: 14px; font-weight: 600;">${browser}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #718096; font-size: 13px;">IP Address</td>
              <td style="padding: 8px 0; color: #1a202c; font-size: 14px; font-weight: 600;">${ipAddress}</td>
            </tr>
          </table>
        </div>

        <!-- Warning banner -->
        <div style="background-color: #fffbeb; border: 1px solid #fbbf24; border-radius: 6px; padding: 16px; margin: 24px 0;">
          <p style="margin: 0; font-size: 14px; color: #92400e; line-height: 1.5;">
            <strong>Was this you?</strong> If you did not sign in, your account may be compromised. Please reset your password immediately.
          </p>
        </div>

        <!-- CTA Button -->
        <p style="text-align: center; margin: 28px 0;">
          <a href="${dashboardUrl}/perfil"
             style="background-color: #dc2626; color: #ffffff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 14px; display: inline-block;">
            Secure My Account
          </a>
        </p>

        <p style="font-size: 12px; color: #a0aec0; text-align: center;">
          If this was you, no action is needed. This is an automated security notification.
        </p>
      </div>

      <!-- Footer -->
      <p style="color: #a0aec0; font-size: 11px; text-align: center; margin-top: 16px;">
        &copy; Horizon Consulting — Smart Dashboard
      </p>
    </div>
  `;

  const text = [
    `Hi ${userName},`,
    `A new sign-in was detected on your Smart Dashboard account.`,
    `Date: ${loginDate}`,
    `Time: ${loginTime}`,
    `Device/Browser: ${browser}`,
    `IP Address: ${ipAddress}`,
    `If this wasn't you, please reset your password immediately at ${dashboardUrl}/perfil`,
  ].join('\n');

  return sendEmail(to, subject, html, text);
}
