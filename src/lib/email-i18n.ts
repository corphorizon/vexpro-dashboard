// ─────────────────────────────────────────────────────────────────────────────
// email-i18n — server-side translation helper for transactional emails.
//
// Deliberately NOT the React i18n (src/lib/i18n.tsx): emails render on the
// server (API routes, crons) where React context doesn't exist, and the
// recipient's language is a per-user DB preference, not the viewer's UI
// language.
//
// Rules:
//   · et(locale, key, params?) — looks up the string, interpolates {param}
//     placeholders, falls back locale → en → key.
//   · resolveUserLocale(admin, email) — reads `preferred_language` from
//     company_users first, then platform_users. Missing user, missing
//     column (migration-052 not applied yet) or any query error → 'en'.
//     New users without a preference therefore get ENGLISH.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from '@supabase/supabase-js';

export type EmailLocale = 'en' | 'es';

export function isEmailLocale(v: unknown): v is EmailLocale {
  return v === 'en' || v === 'es';
}

type StringTable = Record<string, string>;

const EMAIL_STRINGS: Record<EmailLocale, StringTable> = {
  // ───────────────────────────── ENGLISH ─────────────────────────────
  en: {
    'common.hi': 'Hi',
    'common.signature': '— Horizon Consulting',
    'common.copyright': '© Horizon Consulting — Smart Dashboard',

    // 1. Welcome
    'welcome.subject': 'Welcome to Smart Dashboard — Horizon Consulting',
    'welcome.title': 'Welcome to Smart Dashboard',
    'welcome.body':
      'Your account has been created successfully. You can now access the Smart Dashboard to view financial reports, manage operations, and collaborate with your team.',
    'welcome.contact': 'If you have any questions, please contact your administrator.',
    'welcome.text':
      'Welcome to Smart Dashboard, {name}! Your account has been created successfully.',

    // 2. Password reset
    'reset.subject': 'Reset your password — Smart Dashboard',
    'reset.title': 'Password Reset Request',
    'reset.intro':
      'We received a request to reset your password. Click the button below to set a new password:',
    'reset.button': 'Reset Password',
    'reset.ignore':
      'If you did not request this, you can safely ignore this email. This link expires in 1 hour.',
    'reset.text':
      'Reset your password by visiting: {link}. If you did not request this, ignore this email.',

    // 3. Dashboard report
    'dreport.subject': 'Financial Report: {name} — {period}',
    'dreport.title': 'Financial Report',
    'dreport.reportLabel': 'Report:',
    'dreport.periodLabel': 'Period:',
    'dreport.footer': 'Log in to Smart Dashboard for the full report and interactive charts.',
    'dreport.textTitle': 'Financial Report: {name} — {period}',

    // 4. 2FA reset code
    'twofa.subject': 'Your 2FA reset code',
    'twofa.title': 'Two-factor reset code',
    'twofa.intro':
      'Use the code below to reset your two-factor authentication. It expires in {minutes} minutes.',
    'twofa.ignore':
      'If you did not request this code, ignore this email — your account is still safe. Never share this code with anyone.',
    'twofa.text':
      'Your 2FA reset code is: {code}\n\nIt expires in {minutes} minutes. If you did not request it, ignore this email.',

    // 5. Notification
    'notif.subject': 'Smart Dashboard Alert: {title}',

    // 6. Login notification
    'login.subject': 'New sign-in to your Horizon Consulting account',
    'login.intro': 'We detected a new sign-in to your Smart Dashboard account. Here are the details:',
    'login.date': 'Date',
    'login.time': 'Time',
    'login.device': 'Device / Browser',
    'login.ip': 'IP Address',
    'login.wasYou': 'Was this you?',
    'login.warning':
      'If you did not sign in, your account may be compromised. Please reset your password immediately.',
    'login.cta': 'Secure My Account',
    'login.noAction': 'If this was you, no action is needed. This is an automated security notification.',
    'login.textIntro': 'A new sign-in was detected on your Smart Dashboard account.',
    'login.textAction': "If this wasn't you, please reset your password immediately at {url}",

    // 7. Invite
    'invite.subject': "You've been invited to {company} — Smart Dashboard",
    'invite.headerTitle': 'Welcome to {company}',
    'invite.body':
      '{inviter} has invited you to join <strong>{company}</strong> on Smart Dashboard. To complete your registration, create a password by clicking the button:',
    'invite.button': 'Create my password',
    'invite.important': 'Important:',
    'invite.expires':
      'This link expires in {hours} hours. If you miss the window, ask your administrator to resend the invitation.',
    'invite.ignore':
      "If you weren't expecting this invitation or don't know {inviter}, you can safely ignore this email.",
    'invite.fallback': "If the button doesn't work, copy this link into your browser:",
    'invite.textBody': '{inviter} has invited you to join {company} on Smart Dashboard.',
    'invite.textLink': 'To create your password, visit: {link}',
    'invite.textExpires': 'This link expires in {hours} hours.',

    // 8. New period opened (cron/create-new-period)
    'period.subject': 'New period opened: {period}',
    'period.message':
      'The period {period} has been created automatically. The period {prevPeriod} remains open for your review and manual close.',

    // Test email (/api/send-email/test)
    'test.subject': 'Smart Dashboard — Test Email',
    'test.message':
      'This is a test email to verify that SendGrid is configured correctly. If you received this, the integration is working!',
  },

  // ───────────────────────────── ESPAÑOL ─────────────────────────────
  es: {
    'common.hi': 'Hola',
    'common.signature': '— Horizon Consulting',
    'common.copyright': '© Horizon Consulting — Smart Dashboard',

    // 1. Bienvenida
    'welcome.subject': 'Bienvenido a Smart Dashboard — Horizon Consulting',
    'welcome.title': 'Bienvenido a Smart Dashboard',
    'welcome.body':
      'Tu cuenta se ha creado correctamente. Ya puedes acceder a Smart Dashboard para ver reportes financieros, gestionar operaciones y colaborar con tu equipo.',
    'welcome.contact': 'Si tienes alguna pregunta, contacta a tu administrador.',
    'welcome.text':
      '¡Bienvenido a Smart Dashboard, {name}! Tu cuenta se ha creado correctamente.',

    // 2. Reset de contraseña
    'reset.subject': 'Restablece tu contraseña — Smart Dashboard',
    'reset.title': 'Solicitud de restablecimiento de contraseña',
    'reset.intro':
      'Recibimos una solicitud para restablecer tu contraseña. Haz click en el botón para crear una nueva:',
    'reset.button': 'Restablecer contraseña',
    'reset.ignore':
      'Si no solicitaste esto, puedes ignorar este correo con tranquilidad. Este enlace expira en 1 hora.',
    'reset.text':
      'Restablece tu contraseña visitando: {link}. Si no lo solicitaste, ignora este correo.',

    // 3. Reporte del dashboard
    'dreport.subject': 'Reporte Financiero: {name} — {period}',
    'dreport.title': 'Reporte Financiero',
    'dreport.reportLabel': 'Reporte:',
    'dreport.periodLabel': 'Período:',
    'dreport.footer':
      'Inicia sesión en Smart Dashboard para ver el reporte completo y los gráficos interactivos.',
    'dreport.textTitle': 'Reporte Financiero: {name} — {period}',

    // 4. Código de reset 2FA
    'twofa.subject': 'Tu código para restablecer 2FA',
    'twofa.title': 'Código de restablecimiento de dos factores',
    'twofa.intro':
      'Usa el código de abajo para restablecer tu autenticación de dos factores. Expira en {minutes} minutos.',
    'twofa.ignore':
      'Si no solicitaste este código, ignora este correo — tu cuenta sigue segura. Nunca compartas este código con nadie.',
    'twofa.text':
      'Tu código para restablecer 2FA es: {code}\n\nExpira en {minutes} minutos. Si no lo solicitaste, ignora este correo.',

    // 5. Notificación
    'notif.subject': 'Alerta de Smart Dashboard: {title}',

    // 6. Notificación de inicio de sesión
    'login.subject': 'Nuevo inicio de sesión en tu cuenta de Horizon Consulting',
    'login.intro':
      'Detectamos un nuevo inicio de sesión en tu cuenta de Smart Dashboard. Estos son los detalles:',
    'login.date': 'Fecha',
    'login.time': 'Hora',
    'login.device': 'Dispositivo / Navegador',
    'login.ip': 'Dirección IP',
    'login.wasYou': '¿Fuiste tú?',
    'login.warning':
      'Si no iniciaste sesión, tu cuenta podría estar comprometida. Restablece tu contraseña de inmediato.',
    'login.cta': 'Proteger mi cuenta',
    'login.noAction':
      'Si fuiste tú, no necesitas hacer nada. Esta es una notificación de seguridad automática.',
    'login.textIntro': 'Se detectó un nuevo inicio de sesión en tu cuenta de Smart Dashboard.',
    'login.textAction': 'Si no fuiste tú, restablece tu contraseña de inmediato en {url}',

    // 7. Invitación (texto original en español — se preserva)
    'invite.subject': 'Te han invitado a {company} — Smart Dashboard',
    'invite.headerTitle': 'Bienvenido a {company}',
    'invite.body':
      '{inviter} te ha invitado a unirte a <strong>{company}</strong> en Smart Dashboard. Para completar tu registro, crea una contraseña haciendo click en el botón:',
    'invite.button': 'Crear mi contraseña',
    'invite.important': 'Importante:',
    'invite.expires':
      'Este enlace expira en {hours} horas. Si no lo usas a tiempo, pídele a tu administrador que te reenvíe la invitación.',
    'invite.ignore':
      'Si no esperabas esta invitación o no conoces a {inviter}, puedes ignorar este correo de manera segura.',
    'invite.fallback': 'Si el botón no funciona, copia este enlace en tu navegador:',
    'invite.textBody': '{inviter} te ha invitado a unirte a {company} en Smart Dashboard.',
    'invite.textLink': 'Para crear tu contraseña, visita: {link}',
    'invite.textExpires': 'Este enlace expira en {hours} horas.',

    // 8. Nuevo período abierto (cron/create-new-period)
    'period.subject': 'Nuevo período abierto: {period}',
    'period.message':
      'Se ha creado automáticamente el período {period}. El período {prevPeriod} sigue abierto para tu revisión y cierre manual.',

    // Email de prueba (/api/send-email/test)
    'test.subject': 'Smart Dashboard — Correo de prueba',
    'test.message':
      'Este es un correo de prueba para verificar que SendGrid está configurado correctamente. Si lo recibiste, ¡la integración funciona!',
  },
};

/**
 * Translate a key for the given locale, interpolating `{param}` placeholders.
 * Fallback chain: requested locale → 'en' → the key itself (so a typo'd key
 * never crashes an email send, it just renders the raw key).
 */
export function et(
  locale: EmailLocale,
  key: string,
  params?: Record<string, string | number>,
): string {
  const raw = EMAIL_STRINGS[locale]?.[key] ?? EMAIL_STRINGS.en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Resolve a recipient's preferred email language by email address.
 *
 * Looks up `company_users.preferred_language` first, then
 * `platform_users.preferred_language`. Any failure — user not found, the
 * column not existing yet (migration-052 pending), network error — falls
 * back to 'en', per the business rule that users without a configured
 * preference receive English.
 */
export async function resolveUserLocale(
  admin: SupabaseClient,
  email: string,
): Promise<EmailLocale> {
  const normalized = email.toLowerCase().trim();
  if (!normalized) return 'en';

  try {
    const { data: cu, error: cuErr } = await admin
      .from('company_users')
      .select('preferred_language')
      .ilike('email', normalized)
      .limit(1)
      .maybeSingle();
    if (!cuErr && cu && isEmailLocale(cu.preferred_language)) {
      return cu.preferred_language;
    }

    const { data: pu, error: puErr } = await admin
      .from('platform_users')
      .select('preferred_language')
      .ilike('email', normalized)
      .limit(1)
      .maybeSingle();
    if (!puErr && pu && isEmailLocale(pu.preferred_language)) {
      return pu.preferred_language;
    }
  } catch (err) {
    console.warn(
      '[email-i18n] resolveUserLocale failed, defaulting to en:',
      err instanceof Error ? err.message : err,
    );
  }

  return 'en';
}
