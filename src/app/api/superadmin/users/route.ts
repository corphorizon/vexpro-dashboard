import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { sanitizeDbError } from '@/lib/errors';
import {
  generateAndSendInvite,
  resolveInviterName,
  originFromRequest,
  ipFromRequest,
} from '@/lib/invite-user';
import { apiError } from '@/lib/api-error';
import { BUILT_IN_ROLES, isBuiltInRole } from '@/lib/roles';
import { sanitizeModuleKeys } from '@/lib/modules';
import { notify } from '@/lib/notifications/notify';

// ---------------------------------------------------------------------------
// GET /api/superadmin/users?company_id=<uuid>
//
// Returns users across every tenant (or a single tenant if company_id set).
// Joins the company name for display convenience. Never returns twofa_secret.
//
// Includes `must_change_password` and `last_login_at` so the UI can show
// the "Reenviar invitación" button only on users that haven't activated
// their account yet.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const companyId = request.nextUrl.searchParams.get('company_id');

    const admin = createAdminClient();
    let query = admin
      .from('company_users')
      .select('id, user_id, company_id, email, name, role, allowed_modules, twofa_enabled, must_change_password, last_login_at, created_at, companies(name, slug, status)')
      .order('created_at', { ascending: false })
      .limit(500);
    if (companyId) query = query.eq('company_id', companyId);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json(sanitizeDbError(error, 'superadmin/users:list'), { status: 500 });
    }

    return NextResponse.json({ success: true, users: data ?? [] });
  } catch (err) {
    return apiError('superadmin/users', err, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /api/superadmin/users
//
// Invite a new user to ANY tenant. The invited user receives an email with
// a setup link (no known password) — see src/lib/invite-user.ts.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { email, name, role, company_id, allowed_modules } = body as {
      email?: string;
      name?: string;
      role?: string;
      company_id?: string;
      allowed_modules?: string[];
    };

    if (!email || !name || !role || !company_id) {
      return NextResponse.json(
        { success: false, error: 'email, name, role y company_id son requeridos' },
        { status: 400 },
      );
    }

    if (!isBuiltInRole(role)) {
      return NextResponse.json(
        { success: false, error: `Rol inválido. Permitidos: ${BUILT_IN_ROLES.join(', ')}` },
        { status: 400 },
      );
    }

    const normalizedEmail = email.trim().toLowerCase();
    const admin = createAdminClient();

    // Verify the target company exists (prevents orphan memberships).
    const { data: company } = await admin
      .from('companies')
      .select('id, name')
      .eq('id', company_id)
      .maybeSingle();
    if (!company) {
      return NextResponse.json(
        { success: false, error: 'La empresa destino no existe' },
        { status: 404 },
      );
    }

    // ─── Exclusividad del email ───────────────────────────────────────
    // Antes solo se miraba la MISMA empresa, y si el email ya existía en otra
    // se reutilizaba su auth.users creando una SEGUNDA fila en company_users.
    // Las tres lecturas de perfil asumen una sola fila (login-gate con
    // maybeSingle, verifyAuth/verifyAdminAuth con .single()), así que esa
    // segunda membresía deja a la persona con 401/403 permanente en LAS DOS
    // empresas. Hasta que exista multi-membresía real, se rechaza.
    const { data: dupes } = await admin
      .from('company_users')
      .select('id, email, role, company_id, companies(name)')
      .ilike('email', normalizedEmail)
      .limit(1);
    const dupe = dupes?.[0];
    if (dupe) {
      const sameCompany = dupe.company_id === company_id;
      return NextResponse.json(
        {
          success: false,
          error: sameCompany
            ? `${email} ya es miembro de esta empresa`
            : `${email} ya tiene una cuenta en otra empresa. Un email solo puede pertenecer a una entidad.`,
          existing: dupe,
        },
        { status: 409 },
      );
    }

    // Superadmin de plataforma: las dos tablas son EXCLUYENTES. Si el email
    // queda en ambas, el cliente y el servidor las resuelven en orden inverso
    // (la UI lo trata como usuario del tenant, la API como superadmin).
    const { data: platformDupe } = await admin
      .from('platform_users')
      .select('id')
      .ilike('email', normalizedEmail)
      .maybeSingle();
    if (platformDupe) {
      return NextResponse.json(
        {
          success: false,
          error: `${email} es un superadmin de plataforma y no puede ser además usuario de una empresa`,
        },
        { status: 409 },
      );
    }

    // ─── Resolve auth.users id ────────────────────────────────────────
    // Reuse existing auth user if email already registered (different
    // tenant). Otherwise create new one with throwaway password.
    let authUserId: string | null = null;
    let createdNewAuthUser = false;

    {
      const target = normalizedEmail;
      for (let page = 1; page <= 20; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) break;
        const found = data?.users?.find((u) => (u.email || '').toLowerCase() === target);
        if (found) {
          authUserId = found.id;
          break;
        }
        if (!data?.users || data.users.length < 200) break;
      }
    }

    if (!authUserId) {
      const placeholderPwd = randomBytes(32).toString('base64url');
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: normalizedEmail,
        password: placeholderPwd,
        email_confirm: true,
      });
      if (createErr || !created?.user?.id) {
        console.error('[superadmin/users:invite] createUser failed:', createErr?.message);
        return apiError('superadmin/users', createErr, { status: 500, clientMessage: 'No se pudo crear el usuario auth' });
      }
      authUserId = created.user.id;
      createdNewAuthUser = true;
    }

    // ─── Insert company_users membership ──────────────────────────────
    const sanitizedModules = sanitizeModuleKeys(allowed_modules);
    const { data: membership, error: memErr } = await admin
      .from('company_users')
      .insert({
        user_id: authUserId,
        company_id,
        email: normalizedEmail,
        name: name.trim(),
        role,
        // Saneado contra el registro de módulos: una clave inventada quedaba
        // guardada y después se descartaba en silencio al leerla.
        allowed_modules: sanitizedModules.length > 0 ? sanitizedModules : ['summary'],
        must_change_password: true,
      })
      .select()
      .single();

    if (memErr) {
      // Roll back auth user only if WE created it.
      if (createdNewAuthUser && authUserId) {
        await admin.auth.admin.deleteUser(authUserId).catch(() => {});
      }
      return NextResponse.json(
        sanitizeDbError(memErr, 'superadmin/users:create-membership'),
        { status: 500 },
      );
    }

    // Aviso al tenant: el alta equivalente del admin de empresa
    // (/api/admin/create-user) sí notifica, y un usuario nuevo creado desde
    // afuera es exactamente lo que los admins tienen que ver.
    const inviterName = await resolveInviterName(admin, auth.userId);

    void notify(admin, {
      companyId: company_id,
      type: 'security.user_created',
      params: { actor: inviterName, target: name.trim() || normalizedEmail, role },
      link: '/usuarios',
      excludeUserIds: [auth.userId],
    });

    // ─── Generate setup token + send email via shared helper ──────────
    const inviteResult = await generateAndSendInvite({
      admin,
      authUserId,
      recipientEmail: normalizedEmail,
      recipientName: name.trim(),
      inviterName,
      companyId: company_id,
      companyName: company.name,
      origin: originFromRequest(request),
      createdIp: ipFromRequest(request),
    });

    if (!inviteResult.success) {
      // Membership already created — return 200 with warning, the
      // superadmin can use "Reenviar invitación" later.
      return NextResponse.json({
        success: true,
        user: membership,
        warning: inviteResult.error || 'Usuario creado pero no se pudo enviar la invitación',
      });
    }

    return NextResponse.json({
      success: true,
      user: membership,
      invited_new_auth_user: createdNewAuthUser,
    });
  } catch (err) {
    return apiError('superadmin/users', err, { status: 500 });
  }
}
