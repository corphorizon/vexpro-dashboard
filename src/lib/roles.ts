// ─────────────────────────────────────────────────────────────────────────────
// Registro ÚNICO de roles de empresa.
//
// Vive fuera de auth-context.tsx porque ese archivo es 'use client' y arrastra
// React: los route handlers no pueden importarlo. Esa fue justamente la causa
// de que /api/admin/update-company-user mantuviera su propia lista, que se
// desincronizó de la realidad:
//
//   · Aceptaba {admin, auditor, hr, viewer}. `viewer` NO existe (el CHECK de
//     company_users.role no lo admite) y faltaban `socio`, `soporte` e
//     `invitado` — o sea que editar el rol de 8 de los 16 usuarios de
//     producción devolvía 400 "Rol no válido".
//   · Aceptaba roles con prefijo `custom:`, que el mismo CHECK rechaza: el
//     insert habría muerto con un error crudo de Postgres.
//
// Esta lista DEBE coincidir con el CHECK de company_users.role. Cambiarla
// exige una migración.
// ─────────────────────────────────────────────────────────────────────────────

export const BUILT_IN_ROLES = [
  'admin',
  'socio',
  'auditor',
  'soporte',
  'hr',
  'invitado',
] as const;

export type BuiltInRole = (typeof BUILT_IN_ROLES)[number];

export const BUILT_IN_ROLE_SET: ReadonlySet<string> = new Set(BUILT_IN_ROLES);

export function isBuiltInRole(value: unknown): value is BuiltInRole {
  return typeof value === 'string' && BUILT_IN_ROLE_SET.has(value);
}

export const BUILT_IN_ROLE_LABELS: Record<BuiltInRole, string> = {
  admin: 'Admin',
  socio: 'Socio',
  auditor: 'Auditor',
  soporte: 'Soporte',
  hr: 'HR',
  invitado: 'Invitado',
};

/**
 * Roles que pueden EJECUTAR escrituras. Espejo de ADMIN_ROLES en
 * src/lib/api-auth.ts: el servidor rechaza con 403 a cualquier otro.
 *
 * Ojo con la distinción, que ya confundió antes: los `allowed_modules`
 * controlan QUÉ VE un usuario, nunca qué puede cambiar. Un `socio` con todos
 * los módulos marcados sigue siendo de solo lectura.
 */
export const WRITE_CAPABLE_ROLES: ReadonlySet<string> = new Set(['admin', 'auditor', 'hr']);

export function roleCanWrite(role: string): boolean {
  return WRITE_CAPABLE_ROLES.has(role);
}
