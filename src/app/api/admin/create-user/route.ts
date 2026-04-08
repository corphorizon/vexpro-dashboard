import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// POST /api/admin/create-user
//
// Creates a new Supabase Auth user + matching company_users record.
// Uses service_role key so the calling admin's session is not disrupted.
// ---------------------------------------------------------------------------

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

    // Validate required fields
    if (!email || !password || !name || !role || !company_id) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: email, password, name, role, company_id' },
        { status: 400 },
      );
    }

    const adminClient = createAdminClient();

    // 0. Check if there's an orphaned auth user with this email (deleted profile but auth still exists).
    // This happens when a user was deleted before delete-user route also cleaned up auth.users.
    // We clean up the orphan so the email can be reused.
    try {
      const { data: existingUsers } = await adminClient.auth.admin.listUsers();
      const orphan = existingUsers?.users.find(u => u.email === email);
      if (orphan) {
        const { data: existingProfile } = await adminClient
          .from('company_users')
          .select('id')
          .eq('user_id', orphan.id)
          .maybeSingle();
        if (!existingProfile) {
          // Orphan auth user — safe to remove
          console.log(`[AdminAPI] Cleaning up orphaned auth user for ${email}`);
          await adminClient.auth.admin.deleteUser(orphan.id);
        } else {
          return NextResponse.json(
            { success: false, error: `Ya existe un usuario activo con el email ${email}` },
            { status: 409 },
          );
        }
      }
    } catch (cleanupErr) {
      console.warn('[AdminAPI] Orphan check failed, proceeding anyway:', cleanupErr);
    }

    // 1. Create the auth user in Supabase Auth
    const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm so user can login immediately
    });

    if (authError) {
      console.error('[AdminAPI] Error creating auth user:', authError.message);
      return NextResponse.json(
        { success: false, error: authError.message },
        { status: 500 },
      );
    }

    const authUserId = authData.user.id;

    // 2. Create the company_users record
    const { error: profileError } = await adminClient
      .from('company_users')
      .insert({
        user_id: authUserId,
        company_id,
        name,
        email,
        role,
        allowed_modules: allowed_modules || ['dashboard'],
      });

    if (profileError) {
      console.error('[AdminAPI] Error creating company_users record:', profileError.message);
      // Try to clean up the auth user since profile creation failed
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
