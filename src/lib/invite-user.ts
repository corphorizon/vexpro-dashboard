import { createHash, randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { appUrl, PLATFORM_ORG } from '@/lib/app-domain';

// ─────────────────────────────────────────────────────────────────────────────
// invite-user
//
// Helper compartido para los flujos de invitación. Reusa la tabla
// `password_reset_tokens` — una invitación es estructuralmente un "primer
// reset de contraseña" (auth user con password placeholder + token con TTL
// 24h + email vía SendGrid → /reset-password?token=...&mode=setup).
//
// Lo usan:
//   · POST /api/superadmin/users               (cross-tenant invite)
//   · POST /api/superadmin/users/[id]/resend-invite
//   · POST /api/admin/create-user              (within-tenant invite)
//   · POST /api/admin/users/[id]/resend-invite
//
// Decisiones de diseño:
//   - Si falla insertar el token → success=false; el email NO se manda
//     (no tiene sentido mandar un link inválido).
//   - Si falla el envío del email → success=false, pero el token ya está
//     en DB; el caller puede ofrecer "Reenviar invitación" sin generar
//     uno nuevo si así lo prefiere — pero en la práctica los callers
//     llaman este helper de nuevo, lo que invalida el viejo y genera
//     uno fresh. Trade-off aceptable.
// ─────────────────────────────────────────────────────────────────────────────

export const INVITE_TOKEN_TTL_HOURS = 24;

/**
 * Busca un auth user por email paginando auth.admin.listUsers (el admin API
 * del SDK no expone búsqueda por email). Registro ÚNICO: lo usan los tres
 * flujos de alta (admin/create-user, superadmin/users y
 * superadmin/companies/[id]/users) — antes cada uno tenía su copia del loop.
 *
 * FAIL-CLOSED a propósito (incidente 2026-10-12): una fila corrupta en
 * auth.users (tokens en NULL, usuario test@vexprofx.com) hacía fallar
 * listUsers con "Database error finding users". Dos de las copias ignoraban
 * ese error con `break` y seguían a createUser "porque el email no se
 * encontró": si el email SÍ existía, el alta moría con un mensaje genérico, y
 * entre intento e intento quedaban cuentas auth huérfanas a medio crear. Un
 * error acá LANZA: el caller corta con 500 y un mensaje accionable — nunca se
 * decide un alta con una búsqueda a medias.
 */
export async function buscarAuthUserPorEmail(
  admin: SupabaseClient,
  email: string,
): Promise<{ id: string } | null> {
  const target = email.toLowerCase().trim();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data?.users?.find((u) => (u.email || '').toLowerCase().trim() === target);
    if (found) return { id: found.id };
    if (!data?.users || data.users.length < 200) return null;
  }
  return null;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface SendInviteParams {
  admin: SupabaseClient;
  authUserId: string;
  recipientEmail: string;
  recipientName: string;
  inviterName: string;
  companyId: string;
  companyName: string;
  origin: string;
  createdIp?: string | null;
}

interface SendInviteResult {
  success: boolean;
  error?: string;
}

/**
 * Generate a fresh invite token and email it. Idempotent across retries:
 * each call invalidates any previous unused tokens for the same auth user.
 */
export async function generateAndSendInvite(params: SendInviteParams): Promise<SendInviteResult> {
  const {
    admin, authUserId, recipientEmail, recipientName, inviterName,
    companyId, companyName, origin, createdIp,
  } = params;

  // Invalidate any previous unused tokens — keeps the active link unique
  // and prevents the user from accidentally consuming an old one.
  await admin
    .from('password_reset_tokens')
    .delete()
    .eq('user_id', authUserId)
    .is('consumed_at', null);

  const rawToken = randomBytes(32).toString('base64url');
  const tokenHash = sha256Hex(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString();

  const { error: tokenErr } = await admin
    .from('password_reset_tokens')
    .insert({
      user_id: authUserId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      created_ip: createdIp ?? null,
    });

  if (tokenErr) {
    console.error('[invite-user] token insert failed:', tokenErr.message);
    return { success: false, error: 'No se pudo generar el token de invitación' };
  }

  const setupUrl = `${origin}/reset-password?token=${encodeURIComponent(rawToken)}&mode=setup`;

  // Dynamic import — `emailService` arrastra sgMail (heavy), evitamos
  // cargarlo en routes que no necesiten emails.
  const { sendInviteEmail } = await import('@/services/emailService');
  const { resolveUserLocale } = await import('@/lib/email-i18n');

  // Idioma del destinatario — usuarios nuevos sin preferencia reciben inglés.
  const locale = await resolveUserLocale(admin, recipientEmail);

  try {
    const result = await sendInviteEmail(
      recipientEmail,
      setupUrl,
      inviterName,
      companyName,
      recipientName,
      INVITE_TOKEN_TTL_HOURS,
      companyId,
      locale,
    );
    if (!result.success) {
      return { success: false, error: result.error || 'No se pudo enviar el email' };
    }
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Email send failed';
    console.error('[invite-user] sendInviteEmail threw:', msg);
    return { success: false, error: msg };
  }
}

/** Resolves a human-readable inviter name from auth.users id. */
export async function resolveInviterName(admin: SupabaseClient, authUserId: string): Promise<string> {
  const { data: pu } = await admin
    .from('platform_users')
    .select('name')
    .eq('user_id', authUserId)
    .maybeSingle();
  if (pu?.name) return pu.name;

  const { data: cu } = await admin
    .from('company_users')
    .select('name')
    .eq('user_id', authUserId)
    .maybeSingle();
  if (cu?.name) return cu.name;

  return `El equipo de ${PLATFORM_ORG}`;
}

/** Builds the public origin URL from a NextRequest. */
export function originFromRequest(request: Request): string {
  const headers = request.headers;
  return (
    headers.get('origin') ||
    (headers.get('host')
      ? `${headers.get('x-forwarded-proto') || 'https'}://${headers.get('host')}`
      : appUrl())
  );
}

/** Extracts caller IP from common headers. */
export function ipFromRequest(request: Request): string | null {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null
  );
}
