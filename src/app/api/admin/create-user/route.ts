import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import {
  generateAndSendInvite,
  resolveInviterName,
  originFromRequest,
  ipFromRequest,
} from '@/lib/invite-user';

// ---------------------------------------------------------------------------
// POST /api/admin/create-user
//
// Tenant admin creates a user in their OWN company by sending an
// invitation. Mirrors the superadmin flow but locked to caller.companyId
// (cannot create users in other tenants).
//
// Security:
//   - Requires admin role on the caller's company (verifyAdminAuth).
//   - role !== 'admin' enforced server-side (only superadmin makes admins).
//   - company_id is taken from the auth context, NOT body — so even a
//     forged body cannot create users in a different tenant.
//
// Flow:
//   1. Reuse existing auth.users id if email is already registered
//      (e.g. user belongs to another tenant), else create new with a
//      throwaway random password.
//   2. Insert company_users membership with must_change_password=true.
//   3. Generate invite token + email via @/lib/invite-user (shared helper).
//
// On error inserting the membership, the auth user is rolled back ONLY
// when WE created it (not pre-existing).
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { email, name, role, allowed_modules } = body as {
      email?: string;
      name?: string;
      role?: string;
      allowed_modules?: string[];
    };

    // Always use the caller's verified company — admins cannot create
    // memberships in other tenants.
    const company_id = auth.companyId;

    if (!email || !name || !role) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: email, name, role' },
        { status: 400 },
      );
    }

    // SECURITY: tenant admins cannot create users with role 'admin'.
    // Only superadmins do that (via /api/superadmin/users).
    if (role === 'admin') {
      return NextResponse.json(
        { success: false, error: 'No tienes permisos para crear usuarios con rol admin. Contacta al superadmin.' },
        { status: 403 },
      );
    }

    const normalizedEmail = email.trim().toLowerCase();
    const adminClient = createAdminClient();

    // Get company name (used in the email body as "Bienvenido a {empresa}").
    const { data: companyRow } = await adminClient
      .from('companies')
      .select('name')
      .eq('id', company_id)
      .maybeSingle();
    const companyName = companyRow?.name || 'la empresa';

    // Guard against duplicate membership in the same company.
    const { data: dupe } = await adminClient
      .from('company_users')
      .select('id')
      .eq('company_id', company_id)
      .ilike('email', normalizedEmail)
      .maybeSingle();
    if (dupe) {
      return NextResponse.json(
        { success: false, error: `Ya existe un usuario con el email ${email} en esta empresa` },
        { status: 409 },
      );
    }

    // ─── Resolve auth.users id ───────────────────────────────────────
    let authUserId: string | null = null;
    let createdNewAuthUser = false;

    {
      const target = normalizedEmail;
      for (let page = 1; page <= 20; page++) {
        const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 200 });
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
      const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
        email: normalizedEmail,
        password: placeholderPwd,
        email_confirm: true,
      });
      if (createErr || !created?.user?.id) {
        console.error('[admin/create-user] createUser failed:', createErr?.message);
        return NextResponse.json(
          { success: false, error: createErr?.message || 'No se pudo crear el usuario auth' },
          { status: 500 },
        );
      }
      authUserId = created.user.id;
      createdNewAuthUser = true;
    }

    // ─── Insert company_users membership ─────────────────────────────
    const { data: membership, error: memErr } = await adminClient
      .from('company_users')
      .insert({
        user_id: authUserId,
        company_id,
        email: normalizedEmail,
        name: name.trim(),
        role,
        allowed_modules: allowed_modules || ['summary'],
        must_change_password: true,
      })
      .select()
      .single();

    if (memErr) {
      if (createdNewAuthUser && authUserId) {
        await adminClient.auth.admin.deleteUser(authUserId).catch(() => {});
      }
      console.error('[admin/create-user] membership insert failed:', memErr.message);
      return NextResponse.json(
        { success: false, error: `No se pudo crear el perfil: ${memErr.message}` },
        { status: 500 },
      );
    }

    // ─── Send invite via shared helper ───────────────────────────────
    const inviterName = await resolveInviterName(adminClient, auth.userId);
    const inviteResult = await generateAndSendInvite({
      admin: adminClient,
      authUserId,
      recipientEmail: normalizedEmail,
      recipientName: name.trim(),
      inviterName,
      companyId: company_id,
      companyName,
      origin: originFromRequest(request),
      createdIp: ipFromRequest(request),
    });

    if (!inviteResult.success) {
      // Membership already created — return success with warning so the
      // admin can retry via "Reenviar invitación" later.
      return NextResponse.json({
        success: true,
        userId: authUserId,
        membershipId: membership.id,
        warning: inviteResult.error || 'Usuario creado pero no se pudo enviar la invitación',
      });
    }

    console.log(`[admin/create-user] User invited: ***@${normalizedEmail.split('@')[1]} (auth: ${authUserId})`);
    return NextResponse.json({
      success: true,
      userId: authUserId,
      membershipId: membership.id,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[admin/create-user] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
