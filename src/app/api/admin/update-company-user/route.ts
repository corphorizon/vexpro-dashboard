import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { verifyAdminAuth } from '@/lib/api-auth';
import { apiError } from '@/lib/api-error';
import { MODULE_KEY_SET } from '@/lib/modules';
import { isBuiltInRole } from '@/lib/roles';
import { guardAdminTarget } from '@/lib/admin-user-guards';

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

// Los campos de 2FA (`twofa_secret`, `twofa_enabled`, `force_2fa_setup`) NO
// van acá: este endpoint escribe crudo lo que llega en el body, así que
// permitirlos dejaba a un admin FIJAR el secreto TOTP de otro usuario y tomar
// su cuenta (o desactivarle el segundo factor). El ciclo de vida del 2FA es
// exclusivo de /api/admin/reset-user-2fa, que solo lo desactiva y limpia el
// secreto pendiente — nunca lo setea. `must_change_password` sí es gestión
// legítima: a lo sumo obliga a la víctima a cambiar su clave, no la compromete.
const ALLOWED_FIELDS = [
  'name',
  'email',
  'role',
  'allowed_modules',
  'must_change_password',
] as const;

// Whitelist of company-level roles. `superadmin` lives in `platform_users`
// and is NEVER assignable through this endpoint. `owner` and any other
// string outside this set is rejected (defense against payload tampering
// to escalate privileges). Custom roles created via /api/admin/custom-roles
// are also accepted by prefix `custom:` so the existing UI keeps working.
// Los roles válidos salen del registro único (src/lib/roles.ts), que refleja
// el CHECK de company_users.role. La lista literal que había acá aceptaba
// `viewer` (inexistente) y omitía socio/soporte/invitado, así que editar el
// rol de la mitad de los usuarios devolvía 400.
//
// Los roles `custom:` ya NO se aceptan: la tabla no los admite y el insert
// moría con un error de constraint. La función de roles personalizados sigue
// pausada (ver el TODO en /usuarios) — cuando se retome hay que ampliar el
// CHECK primero.
function isAllowedRole(value: unknown): value is string {
  return isBuiltInRole(value);
}

// Lista blanca de módulos: cualquier clave fuera de acá se descarta, para que
// un payload manipulado no pueda otorgar acceso a rutas internas.
//
// Antes era un literal duplicado y le faltaba `ib_rebates`. Como el descarte
// es SILENCIOSO, los seis usuarios que ya tenían ese módulo lo perdían sin
// aviso apenas un admin les editaba cualquier otro campo. Ahora sale del
// registro único (src/lib/modules.ts) y no puede volver a desincronizarse.
const VALID_MODULE_KEYS = MODULE_KEY_SET;

export async function POST(request: NextRequest) {
  try {
    const auth = await verifyAdminAuth(request, { requireAdmin: true });
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
      .select('id, company_id, role')
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

    // Un admin de tenant no puede editar la ficha de OTRO admin (solo el
    // superadmin). Sin esto podía degradarle el rol o cambiarle el email.
    const targetGuard = guardAdminTarget(existing.role, auth);
    if (targetGuard) return targetGuard;

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

    // Hardened (2026-06-06 code review): whitelist explícito + bloqueo
    // anti-escalation. Anteriormente solo bloqueábamos role==='admin'
    // para no-superadmins, pero cualquier string distinto pasaba (ej.
    // 'superadmin', 'owner', 'platform_admin') y se persistía en la
    // tabla. La tabla company_users no enforcea el enum, así que la
    // app comparaba contra valores arbitrarios para gates de UI.
    if ('role' in update) {
      if (!isAllowedRole(update.role)) {
        return NextResponse.json(
          { success: false, error: `Rol no válido: ${String(update.role)}` },
          { status: 400 },
        );
      }
      // Solo superadmin puede asignar 'admin' (mantiene el guard
      // original; un admin de empresa no puede crear otro admin).
      if (update.role === 'admin' && !auth.isSuperadmin) {
        return NextResponse.json(
          { success: false, error: 'No tienes permisos para asignar el rol admin' },
          { status: 403 },
        );
      }
    }

    // Hardened: sanitizar allowed_modules contra una whitelist conocida
    // para evitar que un payload tampered grant acceso a /superadmin
    // o módulos internos.
    if ('allowed_modules' in update && Array.isArray(update.allowed_modules)) {
      update.allowed_modules = (update.allowed_modules as unknown[]).filter(
        (m): m is string => typeof m === 'string' && VALID_MODULE_KEYS.has(m),
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
      return apiError('admin/update-company-user', error, { status: 500 });
    }

    return NextResponse.json({ success: true, user: updated });
  } catch (err) {
    return apiError('admin/update-company-user', err, { status: 500 });
  }
}
