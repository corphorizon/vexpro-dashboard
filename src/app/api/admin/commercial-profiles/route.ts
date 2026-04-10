import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

// POST   — create profile   { action: 'create', company_id, ...fields }
// PATCH  — update profile   { action: 'update', id, ...fields }
// DELETE — delete profile   { action: 'delete', id }

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, company_id, ...fields } = body;
    const admin = createAdminClient();

    if (action === 'create') {
      const { data, error } = await admin
        .from('commercial_profiles')
        .insert({ company_id, ...fields, status: fields.status || 'active' })
        .select('id')
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ success: true, id: data.id });
    }

    if (action === 'update') {
      const { error } = await admin
        .from('commercial_profiles')
        .update(fields)
        .eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ success: true });
    }

    if (action === 'delete') {
      await admin.from('commercial_monthly_results').delete().eq('profile_id', id);
      const { error } = await admin.from('commercial_profiles').delete().eq('id', id);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
