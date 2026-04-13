import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// POST /api/admin/audit-log
//
// Persists an audit entry to the audit_logs table. Requires an active session.
// Uses admin client to bypass RLS for writing (audit logs need to persist
// even if the user's RLS policies would normally block the insert).
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    // Verify the caller has an active session
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ success: false }, { status: 401 });
    }

    const body = await request.json();
    const { action, module, details, user_id, user_name } = body;

    if (!action || !module) {
      return NextResponse.json({ success: false }, { status: 400 });
    }

    const admin = createAdminClient();

    // Look up the caller's company
    const { data: profile } = await supabase
      .from('company_users')
      .select('company_id')
      .eq('user_id', user.id)
      .single();

    await admin.from('audit_logs').insert({
      user_id: user_id || user.id,
      user_name: user_name || user.email,
      action,
      module,
      details: details || '',
      company_id: profile?.company_id || null,
      created_at: new Date().toISOString(),
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
