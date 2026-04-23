import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// POST — { action: 'delete', id }

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { action, id } = body;
    const admin = createAdminClient();
    const company_id = auth.companyId;

    if (action === 'delete') {
      if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
      const { error } = await admin.from('employees').delete()
        .eq('id', id)
        .eq('company_id', company_id);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
