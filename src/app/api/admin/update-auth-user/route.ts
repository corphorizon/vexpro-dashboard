import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// POST /api/admin/update-auth-user
//
// Updates a Supabase Auth user's email and/or password.
// Requires the auth user_id (from company_users.user_id).
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
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

    const adminClient = createAdminClient();

    // Build update payload. For email updates we set email_confirm: true so the
    // change applies immediately without triggering Supabase's confirmation flow.
    const updates: Record<string, unknown> = {};
    if (email) {
      updates.email = email;
      updates.email_confirm = true;
    }
    if (password) updates.password = password;

    // If updating email, first check there's no other auth user already using it.
    // If there is and it's an orphan (no company_users profile), clean it up.
    if (email) {
      try {
        const target = email.toLowerCase().trim();
        for (let page = 1; page <= 20; page++) {
          const { data } = await adminClient.auth.admin.listUsers({ page, perPage: 200 });
          const conflict = data?.users?.find(
            u => (u.email || '').toLowerCase().trim() === target && u.id !== authUserId,
          );
          if (conflict) {
            const { data: profile } = await adminClient
              .from('company_users')
              .select('id')
              .eq('user_id', conflict.id)
              .maybeSingle();
            if (profile) {
              return NextResponse.json(
                { success: false, error: `Ya existe un usuario activo con el email ${email}` },
                { status: 409 },
              );
            }
            // Orphan — clean it up so we can reuse the email
            console.log(`[AdminAPI] Cleaning orphan ${conflict.id} blocking email update to ${email}`);
            await adminClient.auth.admin.deleteUser(conflict.id);
            break;
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
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[AdminAPI] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
