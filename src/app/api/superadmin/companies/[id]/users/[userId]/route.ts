import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifySuperadminAuth } from '@/lib/api-auth';
import { serverAuditLog } from '@/lib/server-audit';

// ---------------------------------------------------------------------------
// PATCH /api/superadmin/companies/:id/users/:userId
//
// Update a single company_users membership. Whitelisted fields:
//   name, email, role, status, allowed_modules
//
// Special handling:
//   - If `email` changes, also update auth.users.email via the Admin API so
//     the user can keep logging in with the new address.
//   - Superadmin actions are recorded in audit_logs with a human-readable
//     diff so platform admins can see "who changed what and when".
//
// The :userId here is `company_users.id` (not auth.users.id).
// ---------------------------------------------------------------------------

const ALLOWED_ROLES = ['admin', 'socio', 'auditor', 'soporte', 'hr', 'invitado'];
const ALLOWED_STATUSES = ['active', 'inactive'];

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    const auth = await verifySuperadminAuth();
    if (auth instanceof NextResponse) return auth;
    const { id: companyId, userId } = await params;

    const body = (await request.json()) as Record<string, unknown>;

    const admin = createAdminClient();

    // Load current row so we can scope by company + diff afterwards.
    const { data: before } = await admin
      .from('company_users')
      .select('id, user_id, company_id, name, email, role, status, allowed_modules')
      .eq('id', userId)
      .eq('company_id', companyId)
      .maybeSingle();

    if (!before) {
      return NextResponse.json(
        { success: false, error: 'Usuario no encontrado en esta empresa' },
        { status: 404 },
      );
    }

    const update: Record<string, unknown> = {};

    if (typeof body.name === 'string' && body.name.trim()) {
      update.name = body.name.trim();
    }
    if (typeof body.email === 'string' && body.email.trim()) {
      update.email = body.email.trim().toLowerCase();
    }
    if (typeof body.role === 'string') {
      if (!ALLOWED_ROLES.includes(body.role)) {
        return NextResponse.json(
          { success: false, error: `Rol inválido. Permitidos: ${ALLOWED_ROLES.join(', ')}` },
          { status: 400 },
        );
      }
      update.role = body.role;
    }
    if (typeof body.status === 'string') {
      if (!ALLOWED_STATUSES.includes(body.status)) {
        return NextResponse.json(
          { success: false, error: 'status debe ser active o inactive' },
          { status: 400 },
        );
      }
      update.status = body.status;
    }
    if (Array.isArray(body.allowed_modules)) {
      update.allowed_modules = (body.allowed_modules as unknown[]).filter(
        (m): m is string => typeof m === 'string',
      );
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { success: false, error: 'Ningún campo válido para actualizar' },
        { status: 400 },
      );
    }

    update.updated_at = new Date().toISOString();

    // If email is changing, sync auth.users first so a DB-side success +
    // auth-side failure doesn't leave them unable to log in.
    if (typeof update.email === 'string' && update.email !== before.email) {
      const { error: authErr } = await admin.auth.admin.updateUserById(before.user_id, {
        email: update.email as string,
      });
      if (authErr) {
        return NextResponse.json(
          { success: false, error: `No pude actualizar el email en auth: ${authErr.message}` },
          { status: 500 },
        );
      }
    }

    const { data: after, error } = await admin
      .from('company_users')
      .update(update)
      .eq('id', userId)
      .eq('company_id', companyId)
      .select()
      .single();

    if (error || !after) {
      return NextResponse.json(
        { success: false, error: error?.message || 'No se pudo actualizar' },
        { status: 500 },
      );
    }

    // Audit: build a compact diff of what actually changed.
    const diffs: string[] = [];
    for (const k of Object.keys(update)) {
      if (k === 'updated_at') continue;
      const prev = (before as Record<string, unknown>)[k];
      const next = (update as Record<string, unknown>)[k];
      const prevStr = Array.isArray(prev) ? `[${prev.join(',')}]` : String(prev ?? '');
      const nextStr = Array.isArray(next) ? `[${(next as string[]).join(',')}]` : String(next ?? '');
      if (prevStr !== nextStr) {
        diffs.push(`${k}: "${prevStr}" → "${nextStr}"`);
      }
    }
    if (diffs.length > 0) {
      await serverAuditLog(admin, {
        companyId,
        actorId: auth.userId,
        actorName: auth.name || auth.email,
        action: 'update',
        module: 'users',
        details: `Superadmin actualizó usuario ${before.email} · ${diffs.join(' | ')}`,
      });
    }

    return NextResponse.json({ success: true, user: after });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
