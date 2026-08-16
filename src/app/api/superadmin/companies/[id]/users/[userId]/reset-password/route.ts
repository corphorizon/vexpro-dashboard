import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { serverAuditLog } from '@/lib/server-audit';
import { apiError } from '@/lib/api-error';
import {
  generateAndSendInvite,
  resolveInviterName,
  originFromRequest,
  ipFromRequest,
} from '@/lib/invite-user';
import { notify } from '@/lib/notifications/notify';

// ---------------------------------------------------------------------------
// POST /api/superadmin/companies/:id/users/:userId/reset-password
//
// Manda al usuario un link para volver a crear su contraseña y le limpia el
// lockout.
//
// ANTES NO MANDABA NADA: llamaba a `generateLink({type:'recovery'})` y
// DESCARTABA el link que devuelve. Supabase no envía ese mail por su cuenta
// (todo el correo del repo sale por SendGrid), así que la UI decía "Email de
// recuperación enviado", limpiaba el lockout, y el usuario se quedaba sin
// forma de entrar mientras el operador lo daba por resuelto.
//
// Ahora usa el MISMO helper que "Reenviar invitación"
// (src/lib/invite-user.ts): token propio con TTL de 24h en
// password_reset_tokens + email por SendGrid en el idioma del destinatario.
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id: companyId, userId } = await params;

    const admin = createAdminClient();

    const { data: membership } = await admin
      .from('company_users')
      .select('id, user_id, email, name, companies(name)')
      .eq('id', userId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json(
        { success: false, error: 'Usuario no encontrado en esta empresa' },
        { status: 404 },
      );
    }
    if (!membership.user_id) {
      return NextResponse.json(
        { success: false, error: 'Este usuario no tiene cuenta auth asociada' },
        { status: 400 },
      );
    }

    // Supabase tipa el join como objeto o array según la cardinalidad.
    const companyJoin = membership.companies as { name?: string } | { name?: string }[] | null;
    const companyName = (Array.isArray(companyJoin)
      ? companyJoin[0]?.name
      : companyJoin?.name) || 'la empresa';

    const inviterName = await resolveInviterName(admin, auth.userId);
    const sendResult = await generateAndSendInvite({
      admin,
      authUserId: membership.user_id,
      recipientEmail: membership.email,
      recipientName: membership.name,
      inviterName,
      companyId,
      companyName,
      origin: originFromRequest(request),
      createdIp: ipFromRequest(request),
    });

    // Si el mail no salió NO se limpia el lockout: dejarlo limpio con el
    // operador creyendo que ya está resuelto es exactamente el bug anterior.
    if (!sendResult.success) {
      return NextResponse.json(
        { success: false, error: sendResult.error || 'No se pudo enviar el email de recuperación' },
        { status: 500 },
      );
    }

    // Also clear lockout so the user can log in after resetting.
    await admin
      .from('company_users')
      .update({ failed_login_count: 0, locked_until: null })
      .eq('id', userId);

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: auth.name || auth.email,
      action: 'update',
      module: 'users',
      details: `Superadmin envió email de reset de contraseña a ${membership.email}`,
    });

    // El flujo equivalente del admin de empresa (/api/admin/reset-password) sí
    // avisa al tenant; que la contraseña la resetee la plataforma no lo hace
    // menos relevante para los admins de esa empresa.
    void notify(admin, {
      companyId,
      type: 'security.password_reset',
      params: {
        actor: auth.name || auth.email,
        target: membership.name || membership.email,
      },
      link: '/usuarios',
      excludeUserIds: [auth.userId],
    });

    return NextResponse.json({ success: true, sent_to: membership.email });
  } catch (err) {
    return apiError('superadmin/companies/[id]/users/[userId]/reset-password', err, { status: 500 });
  }
}
