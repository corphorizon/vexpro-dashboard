import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { sanitizeDbError } from '@/lib/errors';
import { isBuiltInRole } from '@/lib/roles';
import { sanitizeModuleKeys } from '@/lib/modules';
import { serverAuditLog } from '@/lib/server-audit';

// ---------------------------------------------------------------------------
// PATCH /api/superadmin/users/:id
//
// Update a company_users membership (role, name, allowed_modules, status-ish).
// The `id` here is `company_users.id` (not auth user id).
// ---------------------------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const body = await request.json();
    const allowed: Record<string, unknown> = {};

    // `name` se copia tal cual (string libre). `role` y `allowed_modules` se
    // validan/sanitizan: antes se persistían crudos, así que un rol arbitrario
    // reventaba el CHECK de company_users.role con un 500 de Postgres, y
    // módulos inventados quedaban guardados y luego se descartaban en silencio
    // al leerlos.
    if ('name' in body) allowed.name = (body as Record<string, unknown>).name;

    if ('role' in body) {
      const role = (body as Record<string, unknown>).role;
      if (!isBuiltInRole(role)) {
        return NextResponse.json(
          { success: false, error: `Rol no válido: ${String(role)}` },
          { status: 400 },
        );
      }
      allowed.role = role;
    }

    if ('allowed_modules' in body) {
      allowed.allowed_modules = sanitizeModuleKeys(
        (body as Record<string, unknown>).allowed_modules,
      );
    }

    if (Object.keys(allowed).length === 0) {
      return NextResponse.json(
        { success: false, error: 'Ningún campo válido para actualizar' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    // Cargamos la fila antes para tener company_id (audit) y target legible.
    const { data: before } = await admin
      .from('company_users')
      .select('id, company_id, name, email, role, allowed_modules')
      .eq('id', id)
      .maybeSingle();

    const { data, error } = await admin
      .from('company_users')
      .update({ ...allowed, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (error || !data) {
      if (error) console.error('[superadmin/users:update]', error);
      return NextResponse.json(
        { success: false, error: 'Usuario no encontrado' },
        { status: 404 },
      );
    }

    // Rastro de la acción del superadmin (mismo criterio que
    // companies/[id]/users/[userId]).
    const target = before?.name || before?.email || id;
    await serverAuditLog(admin, {
      companyId: before?.company_id ?? data.company_id ?? null,
      actorId: auth.userId,
      actorName: auth.name || auth.email,
      action: 'update',
      module: 'users',
      details: `Superadmin actualizó usuario ${target} · campos: ${Object.keys(allowed).join(', ')}`,
    });

    return NextResponse.json({ success: true, user: data });
  } catch (err) {
    return NextResponse.json(
      sanitizeDbError(err, 'superadmin/users[id]:PATCH'),
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/superadmin/users/:id
//
// Removes the company_users membership. Does NOT delete the auth.users row,
// because the same person may have memberships in other tenants. If this was
// the user's last membership AND not a superadmin, the auth.user becomes
// orphaned but harmless (they can't log into the dashboard without a profile).
// ---------------------------------------------------------------------------

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id } = await params;

    const admin = createAdminClient();

    // Cargamos la fila antes de borrarla para poder dejar rastro de a quién y
    // en qué empresa. El DELETE no dejaba NINGUNA traza en audit_logs.
    const { data: before } = await admin
      .from('company_users')
      .select('id, company_id, name, email')
      .eq('id', id)
      .maybeSingle();

    const { error } = await admin
      .from('company_users')
      .delete()
      .eq('id', id);

    if (error) {
      return NextResponse.json(sanitizeDbError(error, 'superadmin/users[id]:delete'), { status: 500 });
    }

    if (before) {
      const target = before.name || before.email || id;
      await serverAuditLog(admin, {
        companyId: before.company_id ?? null,
        actorId: auth.userId,
        actorName: auth.name || auth.email,
        action: 'delete',
        module: 'users',
        details: `Superadmin eliminó membresía de usuario ${target}`,
      });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      sanitizeDbError(err, 'superadmin/users[id]:DELETE'),
      { status: 500 },
    );
  }
}
