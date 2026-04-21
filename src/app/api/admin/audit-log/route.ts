import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// POST /api/admin/audit-log
//
// Persists an audit entry to the audit_logs table. Called from the browser
// helper `src/lib/audit-log.ts` on every user-visible action (login,
// logout, CRUD on egresos/upload/users, exports, etc.).
//
// SECURITY — anti-spoofing hardening:
// Previous version accepted `user_id` and `user_name` from the request body,
// letting any authenticated caller forge audit entries attributed to anyone.
// Now the caller is identified exclusively from the verified token via
// verifyAuth(); body-supplied identity fields are IGNORED. company_id is
// also taken from the token — never from the body.
//
// Why verifyAuth() and not verifyAdminAuth()? The endpoint logs normal-user
// actions (login, self-profile updates, CSV exports, etc.). Restricting to
// admin-only would silently drop every non-admin login/logout from the
// audit trail, which is the opposite of what auditors want.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAuth();
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { action, module, details } = body as {
      action?: string;
      module?: string;
      details?: string;
    };

    if (!action || !module) {
      return NextResponse.json(
        { success: false, error: 'action y module son requeridos' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();
    const { error } = await admin.from('audit_logs').insert({
      // Identity + tenancy come from the verified token — never from body.
      user_id: auth.userId,
      user_name: auth.name || auth.email,
      company_id: auth.companyId,
      action,
      module,
      details: details || '',
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.error('[audit-log] insert failed:', error.message);
      return NextResponse.json({ success: false }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    console.error('[audit-log] unhandled:', msg);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
