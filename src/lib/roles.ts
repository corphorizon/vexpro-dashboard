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
 *
 * ── ESTO ERA FALSO HASTA EL 2026-08-26 ─────────────────────────────────────
 * La frase de arriba describía la intención, no el comportamiento. El gate de
 * rol de `verifyAdminAuth` se aplicaba a TODOS los métodos, así que `socio`
 * —que nunca estuvo en ADMIN_ROLES— era rechazado antes de llegar al gate de
 * módulos: marcaba módulos, veía el menú y cada pantalla le devolvía 403.
 *
 * No era teórico. Sergio (socio de Vex Pro) entró el 2026-08-22 con seis
 * módulos marcados y no pudo leer ninguno.
 *
 * Ya es cierto: `puedeLlamarRuta` en api-auth.ts separa leer de escribir. Leer
 * lo decide el módulo; escribir lo sigue decidiendo el rol, y esta lista sigue
 * siendo la única que lo define.
 */
export const WRITE_CAPABLE_ROLES: ReadonlySet<string> = new Set(['admin', 'auditor', 'hr']);

export function roleCanWrite(role: string): boolean {
  return WRITE_CAPABLE_ROLES.has(role);
}

/**
 * Dominios de escritura. Los usa el servidor (verifyAdminAuth) Y la UI: un
 * botón de acción que el servidor va a rechazar con 403 no debe dibujarse.
 * Viven acá y no en api-auth.ts porque este archivo no arrastra next/server
 * y puede importarse desde componentes cliente.
 */
export const FINANCE_ROLES = ['admin', 'auditor'] as const;
export const HR_ROLES = ['admin', 'hr'] as const;

/**
 * Lectura de Órdenes de Pago. Más ancho que FINANCE_ROLES a propósito
 * (Kevin, 2026-08-18): el perfil de RRHH necesita VER las órdenes —muchas
 * son salarios— sin poder crear, aprobar ni pagar. Solo aplica a los GET;
 * toda escritura de OPs sigue exigiendo FINANCE_ROLES. El módulo
 * 'payment_orders' en allowed_modules sigue siendo requisito además del rol.
 */
export const PAYMENT_ORDER_READ_ROLES = ['admin', 'auditor', 'hr'] as const;

/**
 * Asistente de IA (/asistente, migración 100).
 *
 * Son TODOS los roles a propósito, y no es un descuido: el asistente NO
 * ESCRIBE NADA. Sus herramientas sólo leen, y cada una vuelve a preguntar por
 * el módulo que necesita antes de devolver un dato. Quien decide qué se puede
 * ver por el chat es `allowed_modules`, exactamente igual que por pantalla
 * (§4.1: leer lo decide el módulo).
 *
 * La lista existe únicamente porque el endpoint es POST —el mensaje va en el
 * cuerpo— y `puedeLlamarRuta` trata todo lo que no es GET/HEAD como escritura.
 * Sin esta lista, el fallback histórico (admin/auditor/hr) dejaría afuera
 * justo a los dos roles que Kevin nombró en el pedido: `socio` y `soporte`.
 * Es el mismo tropiezo que ya sufrió Sergio el 2026-08-22 con seis módulos
 * marcados y ninguna pantalla que le respondiera.
 */
export const ASSISTANT_ROLES = BUILT_IN_ROLES;

/**
 * Revisión de Retiros. El reparto es de Kevin (2026-08-24) y es una
 * segregación de funciones, no una comodidad: **soporte triajea y escala, el
 * auditor aprueba**.
 *
 * Quien atiende al cliente que reclama su retiro no debería ser quien libera
 * el dinero — esa es toda la idea. Soporte mira la cola, entiende el caso y lo
 * escala; aprobar o rechazar exige rol de finanzas.
 *
 * Ojo con el cruce que había antes de esto: los 5 usuarios de soporte tenían
 * el módulo `risk` y no podían decidir nada, y el auditor —el único rol no
 * admin que puede decidir— NO tenía el módulo y ni siquiera veía la pantalla.
 * El módulo en allowed_modules sigue siendo requisito ADEMÁS del rol.
 */
export const WITHDRAWAL_REVIEW_READ_ROLES = ['admin', 'auditor', 'soporte'] as const;

/** Ver la cola y la ficha. */
export function roleCanReadWithdrawalReview(role: string): boolean {
  return role === 'superadmin' || (WITHDRAWAL_REVIEW_READ_ROLES as readonly string[]).includes(role);
}

/** Escalar o dejar pendiente: no mueve dinero, sólo marca el caso. */
export function roleCanTriageWithdrawal(role: string): boolean {
  return roleCanReadWithdrawalReview(role);
}

/** Aprobar o rechazar: sólo finanzas. */
export function roleCanApproveWithdrawal(role: string): boolean {
  return roleCanWriteFinance(role);
}

export function roleCanWriteFinance(role: string): boolean {
  // El superadmin de plataforma llega al cliente con effective_role
  // 'superadmin' (no figura en FINANCE_ROLES porque esa lista alimenta el
  // CHECK de company_users), pero el servidor lo trata como 'admin' en toda
  // ruta de finanzas — mismo criterio que canAdd/canEdit en auth-context.
  return role === 'superadmin' || (FINANCE_ROLES as readonly string[]).includes(role);
}
