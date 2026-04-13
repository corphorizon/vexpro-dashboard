import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// POST   — create profile   { action: 'create', ...fields }
// PATCH  — update profile   { action: 'update', id, ...fields }
// DELETE — delete profile   { action: 'delete', id }

// Fields a client is allowed to set on commercial_profiles.
// Must match actual DB columns — no 'phone' (doesn't exist in table).
const ALLOWED_FIELDS = [
  'name', 'role', 'head_id', 'net_deposit_pct', 'extra_pct', 'pnl_pct',
  'commission_per_lot', 'salary', 'fixed_salary', 'benefits', 'comments',
  'status', 'email', 'hire_date', 'birthday', 'contract_url',
] as const;

function pickAllowed(obj: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED_FIELDS) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { action, id } = body;
    const admin = createAdminClient();

    // Always use the caller's verified company — never trust body.company_id
    const company_id = auth.companyId;

    if (action === 'create') {
      const safe = pickAllowed(body);
      const { data, error } = await admin
        .from('commercial_profiles')
        .insert({ company_id, ...safe, status: (safe.status as string) || 'active' })
        .select('id')
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ success: true, id: data.id });
    }

    if (action === 'update') {
      if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
      const safe = pickAllowed(body);
      const { error } = await admin
        .from('commercial_profiles')
        .update(safe)
        .eq('id', id)
        .eq('company_id', company_id); // scope to caller's company
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ success: true });
    }

    if (action === 'delete') {
      if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
      await admin.from('commercial_monthly_results').delete()
        .eq('profile_id', id)
        .eq('company_id', company_id);
      const { error } = await admin.from('commercial_profiles').delete()
        .eq('id', id)
        .eq('company_id', company_id); // scope to caller's company
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
