import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';

// ---------------------------------------------------------------------------
// POST /api/admin/update-company-user
//
// Edita campos del perfil de un company_user (name, email, role,
// allowed_modules, twofa_*, etc.) usando el admin client para bypassear
// RLS. Necesario porque el UPDATE browser-side de `company_users` queda
// silenciosamente filtrado por RLS cuando un superadmin opera en modo
// viewing-as una empresa donde no es miembro — la query no tira error
// pero tampoco escribe nada, y el cambio se "perdía" sin feedback.
//
// Cross-tenant guard: la fila objetivo debe pertenecer a auth.companyId.
// El sync hacia `auth.users` (email/password) sigue yendo por su
// endpoint dedicado /api/admin/update-auth-user.
// ---------------------------------------------------------------------------

const ALLOWED_FIELDS = [
  'name',
  'email',
  'role',
  'allowed_modules',
  'twofa_enabled',
  'twofa_secret',
  'force_2fa_setup',
  'must_change_password',
] as const;

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json();
    const { companyUserId } = body as { companyUserId?: string };
    if (!companyUserId) {
      return NextResponse.json(
        { success: false, error: 'companyUserId requerido' },
        { status: 400 },
      );
    }

    const admin = createAdminClient();

    const { data: existing } = await admin
      .from('company_users')
      .select('id, company_id')
      .eq('id', companyUserId)
      .maybeSingle();

    if (!existing) {
      return NextResponse.json(
        { success: false, error: 'Usuario no encontrado' },
        { status: 404 },
      );
    }
    if (existing.company_id !== auth.companyId) {
      return NextResponse.json(
        { success: false, error: 'Este usuario no pertenece a tu empresa' },
        { status: 403 },
      );
    }

    // Filtrar a los campos permitidos — defensa contra payloads que
    // intenten setear company_id, user_id, created_at, etc.
    const update: Record<string, unknown> = {};
    for (const f of ALLOWED_FIELDS) {
      if (f in body) update[f] = body[f];
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { success: false, error: 'No hay campos válidos para actualizar' },
        { status: 400 },
      );
    }

    // Si se cambia el rol, prohibir crear admins desde este path:
    // sólo el superadmin puede asignar 'admin' (vía /api/superadmin/users).
    if ('role' in update && update.role === 'admin' && !auth.isSuperadmin) {
      return NextResponse.json(
        { success: false, error: 'No tienes permisos para asignar el rol admin' },
        { status: 403 },
      );
    }

    const { data: updated, error } = await admin
      .from('company_users')
      .update(update)
      .eq('id', companyUserId)
      .select()
      .single();

    if (error) {
      console.error('[admin/update-company-user]', error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, user: updated });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Error' },
      { status: 500 },
    );
  }
}
