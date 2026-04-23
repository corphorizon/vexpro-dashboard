import { NextRequest, NextResponse } from 'next/server';
import { verifyAdminAuth } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// /api/admin/custom-roles — CRUD for per-company role definitions
//
// GET              → list custom roles of the caller's company
// POST {action:'create', ...}  → create a role
// POST {action:'update', id, ...} → update a role (not name if assigned)
// POST {action:'delete', id}    → delete a role (fails if assigned to users)
//
// All actions require admin role. Scoped by company_id.
// ---------------------------------------------------------------------------

const BUILT_IN_ROLES = ['admin', 'socio', 'auditor', 'soporte', 'hr', 'invitado'];

export async function GET(request: NextRequest) {
  const auth = await verifyAdminAuth(request);
  if (auth instanceof NextResponse) return auth;

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from('custom_roles')
    .select('id, name, description, base_role, default_modules, created_at, updated_at')
    .eq('company_id', auth.companyId)
    .order('name');

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, roles: data || [] });
}

export async function POST(request: NextRequest) {
  const auth = await verifyAdminAuth(request);
  if (auth instanceof NextResponse) return auth;

  // Only company admins may manage roles (auditor / hr excluded).
  if (auth.role !== 'admin') {
    return NextResponse.json(
      { success: false, error: 'Solo administradores pueden gestionar roles' },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const { action } = body as { action?: string };
  const adminClient = createAdminClient();

  if (action === 'create' || action === 'update') {
    const { id, name, description, base_role, default_modules } = body as {
      id?: string;
      name?: string;
      description?: string;
      base_role?: string;
      default_modules?: string[];
    };

    if (!name || !base_role) {
      return NextResponse.json(
        { success: false, error: 'name y base_role requeridos' },
        { status: 400 },
      );
    }
    if (!BUILT_IN_ROLES.includes(base_role)) {
      return NextResponse.json(
        { success: false, error: 'base_role inválido' },
        { status: 400 },
      );
    }
    // Prevent shadowing built-in names — they must not collide.
    const trimmed = name.trim();
    if (BUILT_IN_ROLES.includes(trimmed.toLowerCase())) {
      return NextResponse.json(
        { success: false, error: 'Ese nombre está reservado' },
        { status: 400 },
      );
    }

    const payload = {
      company_id: auth.companyId,
      name: trimmed,
      description: description ?? null,
      base_role,
      default_modules: default_modules ?? [],
      updated_at: new Date().toISOString(),
    };

    if (action === 'create') {
      const { data, error } = await adminClient
        .from('custom_roles')
        .insert({ ...payload, created_by: auth.userId })
        .select()
        .single();
      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 400 });
      }
      return NextResponse.json({ success: true, role: data });
    }

    // update
    if (!id) {
      return NextResponse.json({ success: false, error: 'id requerido' }, { status: 400 });
    }
    const { data, error } = await adminClient
      .from('custom_roles')
      .update(payload)
      .eq('id', id)
      .eq('company_id', auth.companyId)
      .select()
      .single();
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: true, role: data });
  }

  if (action === 'delete') {
    const { id } = body as { id?: string };
    if (!id) {
      return NextResponse.json({ success: false, error: 'id requerido' }, { status: 400 });
    }

    // Verify no user still has this role assigned
    const { data: role } = await adminClient
      .from('custom_roles')
      .select('name')
      .eq('id', id)
      .eq('company_id', auth.companyId)
      .maybeSingle();

    if (!role) {
      return NextResponse.json({ success: false, error: 'Rol no encontrado' }, { status: 404 });
    }

    const { count } = await adminClient
      .from('company_users')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', auth.companyId)
      .eq('role', role.name);

    if ((count ?? 0) > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `No se puede eliminar: ${count} usuario(s) tienen este rol asignado`,
        },
        { status: 409 },
      );
    }

    const { error } = await adminClient
      .from('custom_roles')
      .delete()
      .eq('id', id)
      .eq('company_id', auth.companyId);
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: 'Acción no válida' }, { status: 400 });
}
