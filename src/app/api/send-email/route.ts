import { NextRequest, NextResponse } from 'next/server';
import type {
  SendEmailRequest,
  EmailType,
  WelcomeEmailData,
  PasswordResetEmailData,
  ReportEmailData,
  NotificationEmailData,
  LoginNotificationData,
} from '@/lib/types';
import {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendDashboardReportEmail,
  sendNotificationEmail,
  sendLoginNotificationEmail,
} from '@/services/emailService';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_EMAIL_TYPES: EmailType[] = ['welcome', 'password_reset', 'report', 'notification', 'login_notification'];

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateBody(body: unknown): { valid: true; data: SendEmailRequest } | { valid: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body is required' };
  }

  const { to, type, data } = body as Record<string, unknown>;

  if (!to || typeof to !== 'string') {
    return { valid: false, error: '"to" field is required and must be a string' };
  }

  if (!isValidEmail(to)) {
    return { valid: false, error: '"to" must be a valid email address' };
  }

  if (!type || typeof type !== 'string') {
    return { valid: false, error: '"type" field is required and must be a string' };
  }

  if (!VALID_EMAIL_TYPES.includes(type as EmailType)) {
    return { valid: false, error: `"type" must be one of: ${VALID_EMAIL_TYPES.join(', ')}` };
  }

  if (!data || typeof data !== 'object') {
    return { valid: false, error: '"data" field is required and must be an object' };
  }

  // Validate data shape per type
  switch (type as EmailType) {
    case 'welcome': {
      const d = data as Partial<WelcomeEmailData>;
      if (!d.userName) return { valid: false, error: '"data.userName" is required for welcome emails' };
      break;
    }
    case 'password_reset': {
      const d = data as Partial<PasswordResetEmailData>;
      if (!d.resetLink) return { valid: false, error: '"data.resetLink" is required for password reset emails' };
      break;
    }
    case 'report': {
      const d = data as Partial<ReportEmailData>;
      if (!d.reportName) return { valid: false, error: '"data.reportName" is required for report emails' };
      if (!d.reportPeriod) return { valid: false, error: '"data.reportPeriod" is required for report emails' };
      if (!d.reportSummary) return { valid: false, error: '"data.reportSummary" is required for report emails' };
      break;
    }
    case 'notification': {
      const d = data as Partial<NotificationEmailData>;
      if (!d.title) return { valid: false, error: '"data.title" is required for notification emails' };
      if (!d.message) return { valid: false, error: '"data.message" is required for notification emails' };
      break;
    }
    case 'login_notification': {
      const d = data as Partial<LoginNotificationData>;
      if (!d.userName) return { valid: false, error: '"data.userName" is required for login notification emails' };
      if (!d.loginDate) return { valid: false, error: '"data.loginDate" is required for login notification emails' };
      if (!d.loginTime) return { valid: false, error: '"data.loginTime" is required for login notification emails' };
      break;
    }
  }

  return { valid: true, data: body as SendEmailRequest };
}

// ---------------------------------------------------------------------------
// POST /api/send-email
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validation = validateBody(body);

    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }

    const { to, type, data } = validation.data;

    let result;

    switch (type) {
      case 'welcome':
        result = await sendWelcomeEmail(to, (data as WelcomeEmailData).userName);
        break;
      case 'password_reset':
        result = await sendPasswordResetEmail(to, (data as PasswordResetEmailData).resetLink);
        break;
      case 'report': {
        const r = data as ReportEmailData;
        result = await sendDashboardReportEmail(to, r.reportName, r.reportPeriod, r.reportSummary);
        break;
      }
      case 'notification': {
        const n = data as NotificationEmailData;
        result = await sendNotificationEmail(to, n.title, n.message);
        break;
      }
      case 'login_notification': {
        const l = data as LoginNotificationData;
        result = await sendLoginNotificationEmail(to, l.userName, {
          loginDate: l.loginDate,
          loginTime: l.loginTime,
          browser: l.browser || 'Unknown Device',
          ipAddress: l.ipAddress || 'Unknown IP',
          dashboardUrl: l.dashboardUrl || '',
        });
        break;
      }
    }

    if (!result.success) {
      return NextResponse.json(result, { status: 500 });
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[API /send-email] Unhandled error:', message);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
