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
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
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

    // Guard against duplicate membership in the same company.
    const { data: dupe } = await admin
      .from('company_users')
      .select('id, email, role')
      .eq('company_id', company_id)
      .ilike('email', normalizedEmail)
      .maybeSingle();
    if (dupe) {
      return NextResponse.json(
        { success: false, error: `${email} ya es miembro de esta empresa`, existing: dupe },
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
        return NextResponse.json(
          { success: false, error: createErr?.message || 'No se pudo crear el usuario auth' },
          { status: 500 },
        );
      }
      authUserId = created.user.id;
      createdNewAuthUser = true;
    }

    // ─── Insert company_users membership ──────────────────────────────
    const { data: membership, error: memErr } = await admin
      .from('company_users')
      .insert({
        user_id: authUserId,
        company_id,
        email: normalizedEmail,
        name: name.trim(),
        role,
        allowed_modules: allowed_modules ?? ['summary'],
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

    // ─── Generate setup token + send email via shared helper ──────────
    const inviterName = await resolveInviterName(admin, auth.userId);
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
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
