import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// POST /api/admin/reset-password
//
// Resets a user's password by email. Uses service_role key so the admin
// can reset any user's password without knowing the current one.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { email, newPassword } = body as {
      email?: string;
      newPassword?: string;
    };

    if (!email || !newPassword) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: email, newPassword' },
        { status: 400 },
      );
    }

    const adminClient = createAdminClient();

    // Find the auth user by email
    const { data: users, error: listError } = await adminClient.auth.admin.listUsers();

    if (listError) {
      console.error('[AdminAPI] Error listing users:', listError.message);
      return NextResponse.json(
        { success: false, error: listError.message },
        { status: 500 },
      );
    }

    const authUser = users.users.find(u => u.email === email);

    if (!authUser) {
      return NextResponse.json(
        { success: false, error: `No auth user found with email: ${email}` },
        { status: 404 },
      );
    }

    // Update the password
    const { error: updateError } = await adminClient.auth.admin.updateUserById(authUser.id, {
      password: newPassword,
    });

    if (updateError) {
      console.error('[AdminAPI] Error resetting password:', updateError.message);
      return NextResponse.json(
        { success: false, error: updateError.message },
        { status: 500 },
      );
    }

    console.log(`[AdminAPI] Password reset for: ${email}`);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[AdminAPI] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
