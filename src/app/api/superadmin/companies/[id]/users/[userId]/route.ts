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

    // Email syncing: we write company_users FIRST, then auth.users. If auth
    // fails we roll the company_users row back to the old email so the two
    // stores never diverge. The previous order (auth first) meant an auth
    // success + a DB failure left us with a mismatch and no way to detect
    // it post-hoc.
    const emailChanged =
      typeof update.email === 'string' && update.email !== before.email;

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

    if (emailChanged) {
      const { error: authErr } = await admin.auth.admin.updateUserById(
        before.user_id,
        { email: update.email as string },
      );
      if (authErr) {
        // Roll back company_users.email so the two sides stay in sync.
        // updated_at stays as-is; the rollback is best-effort — if it fails
        // too we log loudly so an operator can fix it by hand.
        const { error: rollbackErr } = await admin
          .from('company_users')
          .update({ email: before.email })
          .eq('id', userId);
        if (rollbackErr) {
          console.error(
            '[superadmin/users PATCH] CRITICAL: email desync. auth.users still has old email, company_users has new email, rollback failed',
            { userId, before: before.email, attempted: update.email, rollbackErr: rollbackErr.message },
          );
        }
        return NextResponse.json(
          { success: false, error: `No pude actualizar el email en auth: ${authErr.message}` },
          { status: 500 },
        );
      }
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
