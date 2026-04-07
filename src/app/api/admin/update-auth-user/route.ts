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

    const updates: Record<string, string> = {};
    if (email) updates.email = email;
    if (password) updates.password = password;

    const { error } = await adminClient.auth.admin.updateUserById(authUserId, updates);

    if (error) {
      console.error('[AdminAPI] Error updating auth user:', error.message);
      return NextResponse.json(
        { success: false, error: error.message },
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
