import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// POST /api/admin/delete-user
//
// Deletes a user from both company_users AND Supabase Auth.
// Without removing the auth user, the email stays reserved and cannot be reused.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { companyUserId } = body as { companyUserId?: string };

    if (!companyUserId) {
      return NextResponse.json(
        { success: false, error: '"companyUserId" is required' },
        { status: 400 },
      );
    }

    const adminClient = createAdminClient();

    // 1. Look up the auth user_id from company_users
    const { data: profile, error: lookupError } = await adminClient
      .from('company_users')
      .select('user_id, email')
      .eq('id', companyUserId)
      .single();

    if (lookupError || !profile) {
      return NextResponse.json(
        { success: false, error: lookupError?.message || 'company_user not found' },
        { status: 404 },
      );
    }

    // 2. Delete from company_users first
    const { error: deleteProfileError } = await adminClient
      .from('company_users')
      .delete()
      .eq('id', companyUserId);

    if (deleteProfileError) {
      console.error('[AdminAPI] Error deleting company_users record:', deleteProfileError.message);
      return NextResponse.json(
        { success: false, error: deleteProfileError.message },
        { status: 500 },
      );
    }

    // 3. Delete the auth user so the email can be reused
    if (profile.user_id) {
      const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(profile.user_id);
      if (deleteAuthError) {
        console.error('[AdminAPI] Error deleting auth user:', deleteAuthError.message);
        // Profile already deleted — return warning but don't fail hard
        return NextResponse.json(
          { success: true, warning: `Profile deleted but auth user removal failed: ${deleteAuthError.message}` },
        );
      }
    }

    console.log(`[AdminAPI] User fully deleted: ${profile.email} (${companyUserId})`);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[AdminAPI] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
