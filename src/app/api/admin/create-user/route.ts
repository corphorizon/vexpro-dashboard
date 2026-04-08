import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// POST /api/admin/create-user
//
// Creates a new Supabase Auth user + matching company_users record.
// Uses service_role key so the calling admin's session is not disrupted.
//
// Robustness:
//   - Tries createUser directly. If it fails with "already registered",
//     paginates through auth.users to locate the orphan, verifies it has
//     no profile in company_users, removes it, and retries the creation.
// ---------------------------------------------------------------------------

// Look up an auth user by email by paginating through admin.listUsers().
// listUsers() returns at most ~50 entries per page, so we must paginate.
async function findAuthUserByEmail(adminClient: SupabaseClient, email: string) {
  const target = email.toLowerCase().trim();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data?.users?.find(u => (u.email || '').toLowerCase().trim() === target);
    if (found) return found;
    if (!data?.users || data.users.length < 200) return null; // last page
  }
  return null;
}

async function insertProfile(
  adminClient: SupabaseClient,
  authUserId: string,
  email: string,
  name: string,
  role: string,
  company_id: string,
  allowed_modules: string[] | undefined,
) {
  return adminClient.from('company_users').insert({
    user_id: authUserId,
    company_id,
    name,
    email,
    role,
    allowed_modules: allowed_modules || ['summary'],
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password, name, role, company_id, allowed_modules } = body as {
      email?: string;
      password?: string;
      name?: string;
      role?: string;
      company_id?: string;
      allowed_modules?: string[];
    };

    if (!email || !password || !name || !role || !company_id) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: email, password, name, role, company_id' },
        { status: 400 },
      );
    }

    const adminClient = createAdminClient();

    // 1. Try to create the auth user directly
    let authUserId: string | null = null;
    const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError) {
      // Detect "already registered" — message varies between Supabase versions
      const msg = (authError.message || '').toLowerCase();
      const isAlreadyRegistered =
        msg.includes('already registered') ||
        msg.includes('already been registered') ||
        msg.includes('already exists') ||
        msg.includes('duplicate');

      if (!isAlreadyRegistered) {
        console.error('[AdminAPI] Error creating auth user:', authError.message);
        return NextResponse.json({ success: false, error: authError.message }, { status: 500 });
      }

      // Email is reserved. Try to locate the orphan and clean it up.
      console.log(`[AdminAPI] Email ${email} already registered — checking for orphan`);
      const existing = await findAuthUserByEmail(adminClient, email);
      if (!existing) {
        return NextResponse.json(
          { success: false, error: `El email ${email} está reservado pero no se pudo localizar el usuario huérfano. Contacta soporte.` },
          { status: 409 },
        );
      }

      // Check if there's an active profile for this auth user
      const { data: existingProfile } = await adminClient
        .from('company_users')
        .select('id')
        .eq('user_id', existing.id)
        .maybeSingle();

      if (existingProfile) {
        return NextResponse.json(
          { success: false, error: `Ya existe un usuario activo con el email ${email}` },
          { status: 409 },
        );
      }

      // Orphan — remove it and retry
      console.log(`[AdminAPI] Cleaning up orphaned auth user ${existing.id} for ${email}`);
      const { error: deleteOrphanError } = await adminClient.auth.admin.deleteUser(existing.id);
      if (deleteOrphanError) {
        console.error('[AdminAPI] Failed to delete orphan:', deleteOrphanError.message);
        return NextResponse.json(
          { success: false, error: `No se pudo limpiar el usuario huérfano: ${deleteOrphanError.message}` },
          { status: 500 },
        );
      }

      // Retry creation
      const retry = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (retry.error || !retry.data?.user) {
        console.error('[AdminAPI] Retry create failed:', retry.error?.message);
        return NextResponse.json(
          { success: false, error: retry.error?.message || 'Retry create failed' },
          { status: 500 },
        );
      }
      authUserId = retry.data.user.id;
    } else {
      authUserId = authData.user.id;
    }

    if (!authUserId) {
      return NextResponse.json({ success: false, error: 'No auth user id returned' }, { status: 500 });
    }

    // 2. Insert the company_users profile
    const { error: profileError } = await insertProfile(
      adminClient,
      authUserId,
      email,
      name,
      role,
      company_id,
      allowed_modules,
    );

    if (profileError) {
      console.error('[AdminAPI] Error creating company_users record:', profileError.message);
      // Roll back the auth user since profile creation failed
      await adminClient.auth.admin.deleteUser(authUserId);
      return NextResponse.json(
        { success: false, error: `Profile creation failed: ${profileError.message}` },
        { status: 500 },
      );
    }

    console.log(`[AdminAPI] User created: ${email} (auth: ${authUserId})`);
    return NextResponse.json({ success: true, userId: authUserId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[AdminAPI] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
