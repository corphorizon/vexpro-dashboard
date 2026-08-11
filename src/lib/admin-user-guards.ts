import { NextResponse } from 'next/server';

// ---------------------------------------------------------------------------
// Guard compartido para las rutas de ciclo de vida de usuarios (/api/admin/*).
//
// Un admin de tenant NO puede operar sobre OTRO usuario con rol 'admin' de su
// misma empresa: resetear su contraseña, desactivarle el 2FA, editar su ficha
// o borrarlo serían todas vías para tomar (o descartar) la cuenta de un par.
// Solo el superadmin de plataforma —que llega a estas rutas con
// isSuperadmin=true— puede gestionar admins. Mismo criterio que ya aplica
// /api/admin/users/[id]/resend-invite al bloquear targets admin.
//
// Se extrae acá para no repetir la comparación en las cinco rutas y que no se
// desincronicen (el patrón de listas duplicadas ya rompió este repo antes).
// ---------------------------------------------------------------------------

/**
 * Devuelve un 403 listo para retornar si el objetivo es un admin y el llamante
 * no es superadmin; `null` si la operación puede continuar.
 *
 * @param targetRole  rol del usuario objetivo (company_users.role).
 * @param caller      info de auth del llamante; solo se mira `isSuperadmin`.
 */
export function guardAdminTarget(
  targetRole: string | null | undefined,
  caller: { isSuperadmin?: boolean },
): NextResponse | null {
  if (targetRole === 'admin' && !caller.isSuperadmin) {
    return NextResponse.json(
      { success: false, error: 'No puedes gestionar a otro administrador' },
      { status: 403 },
    );
  }
  return null;
}
