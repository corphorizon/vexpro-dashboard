import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// Redact emails before logging — server logs are visible in Vercel dashboard.
function redactEmail(email: string | null | undefined): string {
  if (!email) return '(no email)';
  const at = email.indexOf('@');
  if (at <= 0) return '(redacted)';
  return `***@${email.slice(at + 1)}`;
}

// ---------------------------------------------------------------------------
// POST /api/admin/delete-user
//
// Deletes a user from both company_users AND Supabase Auth.
// Without removing the auth user, the email stays reserved and cannot be reused.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { companyUserId } = body as { companyUserId?: string };

    if (!companyUserId) {
      return NextResponse.json(
        { success: false, error: '"companyUserId" is required' },
        { status: 400 },
      );
    }

    const adminClient = createAdminClient();

    // 1. Look up the auth user_id + email from company_users — scoped to
    //    the caller's company to prevent cross-tenant deletion.
    const { data: profile, error: lookupError } = await adminClient
      .from('company_users')
      .select('user_id, email')
      .eq('id', companyUserId)
      .eq('company_id', auth.companyId)
      .maybeSingle();

    if (lookupError) {
      console.error('[AdminAPI] Error looking up company_user:', lookupError.message);
      return NextResponse.json(
        { success: false, error: lookupError.message },
        { status: 500 },
      );
    }

    // If the profile doesn't exist anymore (already deleted in another tab/refresh),
    // treat as success — there's nothing to do.
    if (!profile) {
      console.log(`[AdminAPI] company_user ${companyUserId} not found, nothing to delete`);
      return NextResponse.json({ success: true, alreadyDeleted: true });
    }

    // 2. Delete from company_users (scoped to caller's company)
    const { error: deleteProfileError } = await adminClient
      .from('company_users')
      .delete()
      .eq('id', companyUserId)
      .eq('company_id', auth.companyId);

    if (deleteProfileError) {
      console.error('[AdminAPI] Error deleting company_users record:', deleteProfileError.message);
      return NextResponse.json(
        { success: false, error: deleteProfileError.message },
        { status: 500 },
      );
    }

    // 3. Delete the auth user so the email can be reused.
    //    Tolerate "user not found" — the auth side may already be gone.
    if (profile.user_id) {
      const { error: deleteAuthError } = await adminClient.auth.admin.deleteUser(profile.user_id);
      if (deleteAuthError) {
        const msg = (deleteAuthError.message || '').toLowerCase();
        const notFound = msg.includes('not found') || msg.includes('user_not_found');
        if (!notFound) {
          console.error('[AdminAPI] Error deleting auth user:', deleteAuthError.message);
          // Profile is already deleted — return success with warning
          return NextResponse.json({
            success: true,
            warning: `Perfil eliminado pero no se pudo borrar el auth user: ${deleteAuthError.message}`,
          });
        }
        console.log(`[AdminAPI] Auth user ${profile.user_id} already gone, ignoring`);
      }
    }

    console.log(`[AdminAPI] User fully deleted: ${redactEmail(profile.email)} (${companyUserId})`);
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('[AdminAPI] Unhandled error:', message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
