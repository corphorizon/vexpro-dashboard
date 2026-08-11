import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { serverAuditLog } from '@/lib/server-audit';
import { notify } from '@/lib/notifications/notify';
import { guardAdminTarget } from '@/lib/admin-user-guards';

// Validación mínima de email: presencia de un único '@' con texto a cada lado
// y un punto en el dominio. No pretende ser RFC-completa — solo frenar basura
// evidente antes de escribirla en auth.users.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// ---------------------------------------------------------------------------
// POST /api/admin/update-auth-user
//
// Updates a Supabase Auth user's email and/or password.
// Requires the auth user_id (from company_users.user_id).
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { requireAdmin: true });
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { authUserId, email, password } = body as {
      authUserId?: string;
      email?: string;
      password?: string;
    };

    if (!authUserId) {
      return NextResponse.json(
        { success: false, error: '"authUserId" is required' },
        { status: 400 },
      );
    }

    if (!email && !password) {
      return NextResponse.json(
        { success: false, error: 'At least "email" or "password" must be provided' },
        { status: 400 },
      );
    }

    // Validación de payload ANTES de tocar nada. Antes se escribían email y
    // password crudos: un email malformado se persistía y una password de 1
    // carácter debilitaba la cuenta.
    if (email !== undefined && !EMAIL_RE.test(String(email).trim())) {
      return NextResponse.json(
        { success: false, error: 'Email inválido' },
        { status: 400 },
      );
    }
    if (password !== undefined && String(password).length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { success: false, error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` },
        { status: 400 },
      );
    }

    const adminClient = createAdminClient();

    // Verify the target auth user belongs to the caller's company
    const { data: companyUser } = await adminClient
      .from('company_users')
      .select('id, name, email, role')
      .eq('user_id', authUserId)
      .eq('company_id', auth.companyId)
      .maybeSingle();

    if (!companyUser) {
      return NextResponse.json(
        { success: false, error: 'Usuario no pertenece a tu empresa' },
        { status: 403 },
      );
    }

    // Un admin de tenant no puede cambiar el email/contraseña de OTRO admin
    // (equivale a tomar su cuenta). Solo el superadmin puede.
    const targetGuard = guardAdminTarget(companyUser.role, auth);
    if (targetGuard) return targetGuard;

    // Build update payload. For email updates we set email_confirm: true so the
    // change applies immediately without triggering Supabase's confirmation flow.
    const updates: Record<string, unknown> = {};
    if (email) {
      updates.email = email;
      updates.email_confirm = true;
    }
    if (password) updates.password = password;

    // If updating email, first check there's no other auth user already using it.
    //
    // Antes, cuando el conflicto NO tenía fila en company_users, esta ruta lo
    // trataba como "huérfano" y lo BORRABA con deleteUser. Pero listUsers() no
    // está acotado a ninguna empresa: ese auth user podía pertenecer a otro
    // tenant (o estar a mitad de un alta), y lo borrábamos sin autoridad para
    // hacerlo. El borrado se DESACTIVA: si el email ya está tomado por otro
    // auth user, devolvemos 409 y punto. Nunca borramos usuarios fuera del
    // scope del llamante. Limpiar huérfanos reales es tarea de un proceso
    // administrativo aparte, no de un cambio de email.
    if (email) {
      try {
        const target = email.toLowerCase().trim();
        for (let page = 1; page <= 20; page++) {
          const { data } = await adminClient.auth.admin.listUsers({ page, perPage: 200 });
          const conflict = data?.users?.find(
            u => (u.email || '').toLowerCase().trim() === target && u.id !== authUserId,
          );
          if (conflict) {
            return NextResponse.json(
              { success: false, error: `Ya existe un usuario con el email ${email}` },
              { status: 409 },
            );
          }
          if (!data?.users || data.users.length < 200) break;
        }
      } catch (scanErr) {
        console.warn('[AdminAPI] Email conflict scan failed, proceeding anyway:', scanErr);
      }
    }

    const { error } = await adminClient.auth.admin.updateUserById(authUserId, updates);

    if (error) {
      // Surface the most informative message available
      const detail = (error as { message?: string; status?: number; code?: string }).message
        || (error as unknown as { error_description?: string }).error_description
        || JSON.stringify(error);
      console.error('[AdminAPI] Error updating auth user:', detail, 'fields:', Object.keys(updates).join(','));
      return NextResponse.json(
        { success: false, error: detail },
        { status: 500 },
      );
    }

    console.log(`[AdminAPI] Auth user ${authUserId} updated — fields: ${Object.keys(updates).join(', ')}`);

    // Rastro de seguridad: cambiar el email o la contraseña de otro usuario es
    // una operación sensible que hasta ahora no dejaba ninguna traza. No se
    // registra ningún valor (ni el email nuevo ni la clave), solo qué cambió.
    const changed = [email ? 'email' : null, password ? 'contraseña' : null]
      .filter(Boolean)
      .join(' y ');
    const actor = auth.name || auth.email;
    const targetName = companyUser.name || companyUser.email || authUserId;

    await serverAuditLog(adminClient, {
      companyId: auth.companyId,
      actorId: auth.userId,
      actorName: actor,
      action: 'update',
      module: 'users',
      details: `Credenciales actualizadas (${changed}) para ${targetName}`,
    });

    // Aviso a admins. Si cambió la contraseña reutilizamos el tipo de reset de
    // contraseña (misma severidad/audiencia); si solo cambió el email, no hay
    // un tipo dedicado en el catálogo, así que el rastro queda en el audit log.
    if (password) {
      void notify(adminClient, {
        companyId: auth.companyId,
        type: 'security.password_reset',
        params: { actor, target: targetName },
        link: '/usuarios',
        excludeUserIds: [auth.userId],
      });
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[AdminAPI] Unhandled error:', message);
    return apiError('admin/update-auth-user', err, { status: 500 });
  }
}
