import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// GET /api/superadmin/companies/:id/audit-logs
//
// Returns the most recent audit_log entries for a single tenant. Superadmin
// only — the audit surface for tenant admins has been removed.
//
// Query params:
//   ?limit=50   — max rows (default 50, hard cap 500)
//   ?action=    — optional filter by action (create/update/delete/login/...)
//   ?module=    — optional filter by module key
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const url = request.nextUrl;
    const limitRaw = Number(url.searchParams.get('limit') || 50);
    const limit = Math.min(Math.max(limitRaw, 1), 500);
    const action = url.searchParams.get('action');
    const moduleKey = url.searchParams.get('module');

    const admin = createAdminClient();
    let query = admin
      .from('audit_logs')
      .select('id, timestamp, user_id, user_name, action, module, details')
      .eq('company_id', id)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (action) query = query.eq('action', action);
    if (moduleKey) query = query.eq('module', moduleKey);

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, entries: data ?? [] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
