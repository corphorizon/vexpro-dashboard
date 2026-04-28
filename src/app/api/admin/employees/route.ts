import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// /api/admin/employees — CRUD del recurso `employees`.
//
// Antes solo tenía `action: 'delete'`. El form del tab Empleados en
// /rrhh "guardaba" pero solo actualizaba state local — nunca llegaba a
// BD. Al refrescar o cambiar de tab el empleado desaparecía. Ahora se
// soportan create + update server-side con admin client (bypassa RLS,
// necesario para superadmin viewing-as).
// ---------------------------------------------------------------------------

const EDITABLE_FIELDS = [
  'name',
  'email',
  'position',
  'department',
  'start_date',
  'salary',
  'status',
  'phone',
  'country',
  'notes',
  'birthday',
  'supervisor',
  'comments',
] as const;

function pickEditable(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of EDITABLE_FIELDS) {
    if (f in input) out[f] = input[f];
  }
  return out;
}

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { action, id, employee } = body as {
      action?: string;
      id?: string;
      employee?: Record<string, unknown>;
    };
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

    if (action === 'create') {
      if (!employee || typeof employee !== 'object') {
        return NextResponse.json({ error: 'Missing employee payload' }, { status: 400 });
      }
      const payload = pickEditable(employee);
      if (!payload.name || !payload.email) {
        return NextResponse.json({ error: 'name y email son requeridos' }, { status: 400 });
      }
      // Forzamos company_id desde auth — nunca confiamos en el body.
      const { data, error } = await admin
        .from('employees')
        .insert({ ...payload, company_id })
        .select()
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ success: true, employee: data });
    }

    if (action === 'update') {
      if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
      if (!employee || typeof employee !== 'object') {
        return NextResponse.json({ error: 'Missing employee payload' }, { status: 400 });
      }
      // Cross-tenant guard antes de update.
      const { data: existing } = await admin
        .from('employees')
        .select('id, company_id')
        .eq('id', id)
        .maybeSingle();
      if (!existing) return NextResponse.json({ error: 'Empleado no encontrado' }, { status: 404 });
      if (existing.company_id !== company_id) {
        return NextResponse.json({ error: 'Empleado de otra empresa' }, { status: 403 });
      }
      const payload = pickEditable(employee);
      const { data, error } = await admin
        .from('employees')
        .update(payload)
        .eq('id', id)
        .eq('company_id', company_id)
        .select()
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ success: true, employee: data });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
