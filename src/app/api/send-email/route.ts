import { NextRequest, NextResponse } from 'next/server';
import { friendlyDbMessage } from '@/lib/errors';
import { verifyAdminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, recordFailure, clearAttempts, type AttemptKind } from '@/lib/rate-limit';
import type {
  SendEmailRequest,
  EmailType,
  WelcomeEmailData,
  ReportEmailData,
  NotificationEmailData,
  LoginNotificationData,
} from '@/lib/types';
import {
  sendWelcomeEmail,
  sendDashboardReportEmail,
  sendNotificationEmail,
  sendLoginNotificationEmail,
} from '@/services/emailService';
import { resolveUserLocale } from '@/lib/email-i18n';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

// 'password_reset' was removed on purpose (S4): this route must not send
// reset links. The real flow lives in /api/auth/forgot-password, which
// builds the link server-side and never trusts one from the client.
const VALID_EMAIL_TYPES: EmailType[] = ['welcome', 'report', 'notification', 'login_notification'];

// Durable send quota per company (S4 relay hardening). Reuses the same
// twofa_attempts-backed mechanism used by the auth endpoints.
const SEND_KIND = 'send-email' as const;
const SEND_MAX_PER_WINDOW = 20;
const SEND_WINDOW_MS = 60 * 60 * 1000; // 1 hour

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
    // Sin dominio declarado a propósito: los tipos que acepta cruzan las
    // áreas (welcome = alta de usuario, report = finanzas, notification =
    // genérico) y hoy ninguna pantalla la llama, así que atarla a
    // FINANCE_ROLES o HR_ROLES sería adivinar. Queda en el fallback
    // ADMIN_ROLES; si algún día se le da un único uso, declarar el dominio.
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();

    // S4: this endpoint must never send password reset links — a caller-
    // supplied resetLink is a phishing/account-takeover primitive. The real
    // flow lives in /api/auth/forgot-password.
    if ((body as Record<string, unknown> | null)?.type === 'password_reset') {
      return NextResponse.json(
        { success: false, error: 'Usá el flujo de recuperación de contraseña' },
        { status: 400 },
      );
    }

    const validation = validateBody(body);

    if (!validation.valid) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }

    const { to, type, data } = validation.data;
    const cid = auth.companyId; // use caller's company credentials if configured

    const adminClient = createAdminClient();

    // S4: recipient must belong to the caller's company — this endpoint is
    // not an open relay. `ilike` without wildcards = case-insensitive equality.
    const recipient = to.trim();
    const { data: member } = await adminClient
      .from('company_users')
      .select('id')
      .eq('company_id', cid)
      .ilike('email', recipient)
      .maybeSingle();

    let allowed = !!member;
    if (!allowed && auth.isSuperadmin) {
      // Superadmins may also notify other platform users.
      const { data: pu } = await adminClient
        .from('platform_users')
        .select('id')
        .ilike('email', recipient)
        .maybeSingle();
      allowed = !!pu;
    }

    if (!allowed) {
      return NextResponse.json(
        { success: false, error: 'Solo se puede enviar correo a usuarios de tu organización' },
        { status: 403 },
      );
    }

    // S4: durable send quota — max SEND_MAX_PER_WINDOW sends per company per
    // window. Each send counts as one "attempt"; hitting the max locks the
    // counter for SEND_WINDOW_MS, after which it is reset.
    const quotaOpts = { key: `company:${cid}`, kind: SEND_KIND };
    const gate = await checkRateLimit(adminClient, quotaOpts);
    if (gate.locked) {
      const minutes = Math.ceil(gate.waitMs / 60000);
      return NextResponse.json(
        {
          success: false,
          error: `Límite de envío de correos alcanzado. Intenta de nuevo en ${minutes} minuto${minutes === 1 ? '' : 's'}.`,
        },
        { status: 429 },
      );
    }
    if (gate.failedCount >= SEND_MAX_PER_WINDOW) {
      // Previous window's lock expired — start a fresh window.
      await clearAttempts(adminClient, quotaOpts);
    }
    await recordFailure(adminClient, {
      ...quotaOpts,
      max: SEND_MAX_PER_WINDOW,
      lockMs: SEND_WINDOW_MS,
    });

    // Recipient's preferred email language ('en' when no preference is set).
    const locale = await resolveUserLocale(adminClient, recipient);

    let result;

    switch (type) {
      case 'welcome':
        result = await sendWelcomeEmail(to, (data as WelcomeEmailData).userName, cid, locale);
        break;
      case 'report': {
        const r = data as ReportEmailData;
        result = await sendDashboardReportEmail(to, r.reportName, r.reportPeriod, r.reportSummary, cid, locale);
        break;
      }
      case 'notification': {
        const n = data as NotificationEmailData;
        result = await sendNotificationEmail(to, n.title, n.message, cid, locale);
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
        }, cid, locale);
        break;
      }
      default:
        // Unreachable — validateBody already rejected unknown types.
        return NextResponse.json(
          { success: false, error: 'Tipo de correo no soportado' },
          { status: 400 },
        );
    }

    if (!result.success) {
      return NextResponse.json(result, { status: 500 });
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[API /send-email] Unhandled error:', message);
    return NextResponse.json(
      { success: false, error: friendlyDbMessage(err) },
      { status: 500 },
    );
  }
}
