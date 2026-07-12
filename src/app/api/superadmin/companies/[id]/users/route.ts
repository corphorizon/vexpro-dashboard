import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { serverAuditLog } from '@/lib/server-audit';
import { apiError } from '@/lib/api-error';

// Roles inlined here (not imported from @/lib/auth-context, which is a
// 'use client' module). Cross-runtime imports of client modules into
// server routes have surfaced as `undefined` in production bundles —
// causing things like `L.includes is not a function` from the minified
// `undefined.includes(...)`. See PATCH route comment for context.
const BUILT_IN_ROLES = ['admin', 'socio', 'auditor', 'soporte', 'hr', 'invitado'] as const;

// ---------------------------------------------------------------------------
// GET /api/superadmin/companies/:id/users
//
// Returns the full roster of a single tenant with everything the superadmin
// Users panel needs: role, status, allowed_modules, 2FA state, last_login_at.
// Never returns twofa_secret or twofa_pending_secret.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POST /api/superadmin/companies/:id/users
//
// Superadmin creates a brand-new user inside a specific tenant. Two-step:
//   1. Create auth.users row (so the email can sign in).
//   2. Create company_users row with role + allowed_modules.
//
// If auth says "already registered" we look up the orphan and reuse it
// (or reject if it already belongs to some other tenant). Mirrors the
// pattern in /api/admin/create-user.
// ---------------------------------------------------------------------------

const ALLOWED_ROLES_POST = BUILT_IN_ROLES as readonly string[];

async function findAuthByEmail(admin: SupabaseClient, email: string) {
  const target = email.toLowerCase().trim();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data?.users?.find((u) => (u.email || '').toLowerCase().trim() === target);
    if (found) return found;
    if (!data?.users || data.users.length < 200) return null;
  }
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id: companyId } = await params;

    const body = (await request.json()) as Record<string, unknown>;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const role = typeof body.role === 'string' ? body.role : '';
    const allowedModules = Array.isArray(body.allowed_modules)
      ? (body.allowed_modules as unknown[]).filter((m): m is string => typeof m === 'string')
      : [];

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ success: false, error: 'Email inválido' }, { status: 400 });
    }
    if (!password || password.length < 8) {
      return NextResponse.json(
        { success: false, error: 'La contraseña debe tener al menos 8 caracteres' },
        { status: 400 },
      );
    }
    if (!name) {
      return NextResponse.json({ success: false, error: 'Nombre requerido' }, { status: 400 });
    }
    if (!ALLOWED_ROLES_POST.includes(role)) {
      return NextResponse.json(
        { success: false, error: `Rol inválido. Permitidos: ${ALLOWED_ROLES_POST.join(', ')}` },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const { data: company } = await admin
      .from('companies')
      .select('id, name')
      .eq('id', companyId)
      .maybeSingle();
    if (!company) {
      return NextResponse.json(
        { success: false, error: 'Empresa no encontrada' },
        { status: 404 },
      );
    }

    let authUserId: string | null = null;
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr) {
      const msg = (createErr.message || '').toLowerCase();
      const alreadyRegistered =
        msg.includes('already') || msg.includes('exists') || msg.includes('duplicate');
      if (!alreadyRegistered) {
        return apiError('superadmin/companies/[id]/users', createErr, { status: 500 });
      }
      const existing = await findAuthByEmail(admin, email);
      if (!existing) {
        return NextResponse.json(
          { success: false, error: 'Email reservado pero no se encontró el auth user huérfano' },
          { status: 409 },
        );
      }
      const { data: existingProfile } = await admin
        .from('company_users')
        .select('id, company_id')
        .eq('user_id', existing.id)
        .maybeSingle();
      if (existingProfile) {
        const sameCompany = existingProfile.company_id === companyId;
        return NextResponse.json(
          {
            success: false,
            error: `Ya existe un perfil para ${email}${sameCompany ? ' en esta empresa' : ' en otra empresa'}`,
          },
          { status: 409 },
        );
      }
      // Reuse the orphan auth row rather than delete + recreate — safer
      // than wiping someone's auth ID when we can repurpose it cleanly.
      authUserId = existing.id;
    } else {
      authUserId = created.user.id;
    }

    const { data: profile, error: profileErr } = await admin
      .from('company_users')
      .insert({
        user_id: authUserId,
        company_id: companyId,
        email,
        name,
        role,
        status: 'active',
        allowed_modules: allowedModules.length > 0 ? allowedModules : ['summary'],
      })
      .select()
      .single();

    if (profileErr || !profile) {
      // Only roll back the auth user if WE created it just now.
      if (created?.user?.id) {
        await admin.auth.admin.deleteUser(created.user.id).catch(() => undefined);
      }
      return apiError('superadmin/companies/[id]/users', profileErr, { status: 500, clientMessage: 'No se pudo crear el perfil' });
    }

    await serverAuditLog(admin, {
      companyId,
      actorId: auth.userId,
      actorName: auth.name || auth.email,
      action: 'create',
      module: 'users',
      details: `Superadmin creó usuario ${email} (${role}) en ${company.name}`,
    });

    return NextResponse.json({ success: true, user: profile });
  } catch (err) {
    return apiError('superadmin/companies/[id]/users', err, { status: 500 });
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id: companyId } = await params;

    const admin = createAdminClient();

    const { data: company } = await admin
      .from('companies')
      .select('id, name, active_modules')
      .eq('id', companyId)
      .maybeSingle();
    if (!company) {
      return NextResponse.json(
        { success: false, error: 'Empresa no encontrada' },
        { status: 404 },
      );
    }

    const { data, error } = await admin
      .from('company_users')
      .select(
        'id, user_id, company_id, email, name, role, status, allowed_modules, twofa_enabled, last_login_at, created_at, updated_at',
      )
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });

    if (error) {
      return apiError('superadmin/companies/[id]/users', error, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      users: data ?? [],
      company: { id: company.id, name: company.name, active_modules: company.active_modules ?? [] },
    });
  } catch (err) {
    return apiError('superadmin/companies/[id]/users', err, { status: 500 });
  }
}
