import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { sanitizeDbError } from '@/lib/errors';

// ---------------------------------------------------------------------------
// GET /api/superadmin/users?company_id=<uuid>
//
// Returns users across every tenant (or a single tenant if company_id set).
// Joins the company name for display convenience. Never returns twofa_secret.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;

    const companyId = request.nextUrl.searchParams.get('company_id');

    const admin = createAdminClient();
    let query = admin
      .from('company_users')
      .select('id, user_id, company_id, email, name, role, allowed_modules, twofa_enabled, created_at, companies(name, slug, status)')
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
// Invite a new user to ANY tenant. Differs from /api/admin/create-user in
// two ways:
//   - Caller must be a superadmin, not a company admin.
//   - `company_id` comes from the body (any tenant) instead of being locked
//     to the caller's own company.
//
// Sends a magic-link invite email; the user sets their password on first
// login. No password is accepted via body — we don't want to support
// superadmins choosing passwords for other people.
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

    // Guard against duplicate membership. Someone may already be in the
    // target company — return 409 with the existing row for UI inspection.
    const { data: dupe } = await admin
      .from('company_users')
      .select('id, email, role')
      .eq('company_id', company_id)
      .ilike('email', email.trim())
      .maybeSingle();
    if (dupe) {
      return NextResponse.json(
        { success: false, error: `${email} ya es miembro de esta empresa`, existing: dupe },
        { status: 409 },
      );
    }

    // Invite the user via Supabase Admin API. This creates auth.users and
    // mails a magic link. If the auth user already exists (e.g. member of
    // another tenant) we reuse that account.
    const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
      email.trim(),
      { data: { name, invited_by: auth.userId, role } },
    );

    let authUserId = invited?.user?.id;

    if (inviteErr) {
      // "User already registered" is the typical soft-fail — look them up.
      const target = email.toLowerCase().trim();
      for (let page = 1; page <= 10 && !authUserId; page++) {
        const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        const found = data?.users?.find((u) => (u.email || '').toLowerCase() === target);
        if (found) authUserId = found.id;
        if (!data?.users || data.users.length < 200) break;
      }
      if (!authUserId) {
        // Supabase Auth error — not a Postgres code. Log + return generic.
        console.error('[superadmin/users:invite] Auth invite failed:', inviteErr);
        return NextResponse.json(
          { success: false, error: 'No se pudo enviar la invitación' },
          { status: 500 },
        );
      }
    }

    // Create the company_users membership.
    const { data: membership, error: memErr } = await admin
      .from('company_users')
      .insert({
        user_id: authUserId,
        company_id,
        email: email.trim(),
        name: name.trim(),
        role,
        allowed_modules: allowed_modules ?? ['summary'],
      })
      .select()
      .single();

    if (memErr) {
      return NextResponse.json(
        sanitizeDbError(memErr, 'superadmin/users:create-membership'),
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      user: membership,
      invited_new_auth_user: Boolean(invited?.user && !inviteErr),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
