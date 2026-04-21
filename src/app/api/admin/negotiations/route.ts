import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { sanitizeDbError } from '@/lib/errors';

// GET    — list negotiations  ?profile_id=... (optional)
// POST   — create             { action: 'create', profile_id, title, description?, status? }
// PATCH  — update             { action: 'update', id, ...fields }
// DELETE — delete             { action: 'delete', id }

export async function GET(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;

    const { searchParams } = new URL(request.url);
    const profileId = searchParams.get('profile_id');

    const admin = createAdminClient();
    let query = admin
      .from('commercial_negotiations')
      .select('*')
      .eq('company_id', auth.companyId)
      .order('updated_at', { ascending: false });

    if (profileId) {
      query = query.eq('profile_id', profileId);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json(sanitizeDbError(error, 'negotiations'), { status: 400 });
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(sanitizeDbError(err, 'negotiations'), { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth();
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { action, id, profile_id, ...fields } = body;
    const admin = createAdminClient();

    // Always use verified company_id from auth
    const company_id = auth.companyId;

    if (action === 'create') {
      if (!profile_id || !fields.title) {
        return NextResponse.json({ error: 'profile_id and title are required' }, { status: 400 });
      }
      const { data, error } = await admin
        .from('commercial_negotiations')
        .insert({
          company_id,
          profile_id,
          title: fields.title,
          description: fields.description || null,
          status: fields.status || 'active',
        })
        .select('*')
        .single();
      if (error) return NextResponse.json(sanitizeDbError(error, 'negotiations'), { status: 400 });
      return NextResponse.json({ success: true, negotiation: data });
    }

    if (action === 'update') {
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
      const updateFields: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (fields.title !== undefined) updateFields.title = fields.title;
      if (fields.description !== undefined) updateFields.description = fields.description;
      if (fields.status !== undefined) updateFields.status = fields.status;

      const { data, error } = await admin
        .from('commercial_negotiations')
        .update(updateFields)
        .eq('id', id)
        .eq('company_id', company_id) // scope to caller's company
        .select('*')
        .single();
      if (error) return NextResponse.json(sanitizeDbError(error, 'negotiations'), { status: 400 });
      return NextResponse.json({ success: true, negotiation: data });
    }

    if (action === 'delete') {
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
      const { error } = await admin
        .from('commercial_negotiations')
        .delete()
        .eq('id', id)
        .eq('company_id', company_id); // scope to caller's company
      if (error) return NextResponse.json(sanitizeDbError(error, 'negotiations'), { status: 400 });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(sanitizeDbError(err, 'negotiations'), { status: 500 });
  }
}
