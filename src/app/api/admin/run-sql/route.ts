import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(request: NextRequest) {
  try {
    const { sql } = await request.json();
    const admin = createAdminClient();
    const { data, error } = await admin.rpc('exec_sql', { query: sql });
    if (error) {
      // Try raw query via postgres
      const { error: err2 } = await admin.from('commercial_monthly_results').select('id').limit(0);
      return NextResponse.json({ error: error.message, note: 'RPC not available. Run this SQL in Supabase Dashboard SQL Editor.', sql });
    }
    return NextResponse.json({ success: true, data });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
