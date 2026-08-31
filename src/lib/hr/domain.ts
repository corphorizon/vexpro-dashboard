// ─────────────────────────────────────────────────────────────────────────────
// REGISTRO ÚNICO DEL DOMINIO RRHH — roles comerciales, jerarquía y predicados.
//
// ── El porqué ──────────────────────────────────────────────────────────────
// Antes del 2026-08-31 lo de este archivo estaba repartido en copias que se
// desincronizaban en silencio (el modo de falla número uno del repo, §1.1):
//
//   · `ROLE_LABELS_HR` en src/lib/hr-data.ts — castellano fijo, sin `en`.
//   · `possibleHeads` en rrhh/page.tsx:199 — `p.role === 'sales_manager' ||
//     p.role === 'head'`, escrito a mano.
//   · `salesManagers` / `heads` / `independentBdms` en la misma página — otras
//     tres copias del mismo literal.
//   · `ROLE_BADGE_COLORS` en la página — una cuarta lista con las mismas claves.
//   · La regla de despido (`status === 'inactive' && termination_date`)
//     duplicada en <FiredBadge>, en `firedNameClass`, en la derivación de
//     UnifiedEmployee y en `suggestNetDepositWarnings`.
//
// Agregar un rol (pasó con `bdm_global`) obligaba a acordarse de las cinco.
// Ahora se agrega UNA entrada acá y las pantallas lo heredan.
//
// ── Relación con HR_ROLES (src/lib/roles.ts) ───────────────────────────────
// Son cosas distintas y NO se unifican:
//   · `HR_ROLES` = ['admin','hr'] son roles de PLATAFORMA: quién puede llamar
//     una ruta de RRHH (autorización, §4.1 "escribir lo decide el rol").
//   · Lo de este archivo son roles de NEGOCIO de la fuerza comercial: qué es
//     una persona dentro de la estructura de ventas. No otorgan ningún permiso.
// Un `head` de la estructura comercial puede no tener ni cuenta en el sistema.
//
// ── No hay CHECK en la base ────────────────────────────────────────────────
// El CHECK de `commercial_profiles.role` se eliminó en la migración 011, así
// que pueden aparecer roles libres. Todo lo de acá degrada: un rol desconocido
// se muestra capitalizado, no es líder y no rompe la pantalla.
// ─────────────────────────────────────────────────────────────────────────────

/** Los roles conocidos de la fuerza comercial. Agregar uno acá y nada más. */
export const HR_COMMERCIAL_ROLES = ['sales_manager', 'head', 'bdm', 'bdm_global'] as const;

export type HrCommercialRole = (typeof HR_COMMERCIAL_ROLES)[number];

/** Los idiomas que sirve el dashboard (espejo de src/lib/i18n.tsx). */
export type HrLocale = 'es' | 'en';

type RoleSpec = {
  /**
   * Etiqueta por idioma. Hoy las cuatro coinciden en es/en porque el equipo
   * las usa en inglés hablando en castellano ("el HEAD de Hugo", "los BDM").
   * Están escritas igual a propósito y NO es un copiar-pegar olvidado: el día
   * que alguien traduzca "Sales Manager" a "Gerente Comercial" se cambia acá.
   */
  label: Record<HrLocale, string>;
  /** Tiene equipo colgando: puede ser `head_id` de otros perfiles. */
  leader: boolean;
  /** Clases del badge de la pantalla. Va acá para no abrir una quinta lista. */
  badge: string;
};

const ROLE_SPECS: Record<HrCommercialRole, RoleSpec> = {
  sales_manager: {
    label: { es: 'Sales Manager', en: 'Sales Manager' },
    leader: true,
    badge: 'bg-warning/10 text-warning',
  },
  head: {
    label: { es: 'HEAD', en: 'HEAD' },
    leader: true,
    badge: 'bg-violet-50 dark:bg-violet-950/50 text-violet-700 dark:text-violet-400',
  },
  bdm: {
    label: { es: 'BDM', en: 'BDM' },
    leader: false,
    badge: 'bg-info/10 text-info',
  },
  bdm_global: {
    label: { es: 'BDM GLOBAL', en: 'BDM GLOBAL' },
    leader: false,
    badge: 'bg-info/10 text-info',
  },
};

const DEFAULT_BADGE = 'bg-gray-50 dark:bg-gray-900/50 text-gray-700 dark:text-gray-400';

function isKnownRole(role: string): role is HrCommercialRole {
  return (HR_COMMERCIAL_ROLES as readonly string[]).includes(role);
}

/** Capitaliza un rol libre (los que quedaron sin CHECK desde la migr. 011). */
function fallbackLabel(role: string): string {
  return role ? role.charAt(0).toUpperCase() + role.slice(1) : role;
}

/** La etiqueta de un rol en el idioma pedido. Rol desconocido → capitalizado. */
export function hrRoleLabel(role: string, locale: HrLocale = 'es'): string {
  return isKnownRole(role) ? ROLE_SPECS[role].label[locale] : fallbackLabel(role);
}

/** Las clases del badge de un rol. Rol desconocido → gris. */
export function hrRoleBadgeClass(role: string): string {
  return isKnownRole(role) ? ROLE_SPECS[role].badge : DEFAULT_BADGE;
}

/**
 * Compatibilidad: el mapa indexable que usaban las seis pantallas de RRHH.
 * Se mantiene como Proxy (mismo comportamiento que tenía en hr-data.ts,
 * incluida la capitalización del rol desconocido) para no reescribir cada
 * `ROLE_LABELS_HR[p.role]` del módulo, pero LA FUENTE es `ROLE_SPECS`.
 */
export const ROLE_LABELS_HR: Record<string, string> = new Proxy(
  {} as Record<string, string>,
  {
    get: (_t, prop: string) => hrRoleLabel(prop, 'es'),
    // Sin esto, `'bdm' in ROLE_LABELS_HR` y los `Object.keys` dan resultados
    // incoherentes con el `get`.
    has: (_t, prop: string) => isKnownRole(prop),
    ownKeys: () => [...HR_COMMERCIAL_ROLES],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  },
);

// ─── Jerarquía ───────────────────────────────────────────────────────────────

/** Roles que pueden tener gente a cargo (y por lo tanto ser `head_id`). */
export const HR_LEADER_ROLES: readonly HrCommercialRole[] = HR_COMMERCIAL_ROLES.filter(
  (r) => ROLE_SPECS[r].leader,
);

/** ¿Este rol lidera un equipo? (sales_manager y head). */
export function esLider(role: string): boolean {
  return isKnownRole(role) && ROLE_SPECS[role].leader;
}

/** ¿Es un BDM, global o no? Lo que se lista bajo un líder. */
export function esBdm(role: string): boolean {
  return role === 'bdm' || role === 'bdm_global';
}

/** El BDM GLOBAL lleva su propio pin en la pantalla y sus propios %. */
export function esBdmGlobal(role: string): boolean {
  return role === 'bdm_global';
}

/**
 * ¿Puede `headRole` ser el `head_id` de alguien con `memberRole`?
 *
 * Hoy la regla es simple —lidera quien es líder— y NO se restringe por nivel a
 * propósito: en la estructura real de Vex Pro hay heads colgando de heads
 * (Hugo Ortiz tiene cuatro) y prohibirlo dejaría perfiles reales sin poder
 * guardarse. Lo único que se impide es colgarse de uno mismo, que es el ciclo
 * A→A que `buildForest` tiene que cortar después.
 */
export function puedeSerHeadDe(headRole: string, memberRole: string): boolean {
  return esLider(headRole) && (esLider(memberRole) || esBdm(memberRole));
}

/** Los perfiles que pueden aparecer en el selector "Supervisor" de un perfil. */
export function possibleHeads<T extends { id: string; role: string }>(
  profiles: readonly T[],
  opts?: { excludeId?: string },
): T[] {
  return profiles.filter((p) => esLider(p.role) && p.id !== opts?.excludeId);
}

// ─── Predicados de estado ────────────────────────────────────────────────────

/** Lo mínimo que hace falta para decidir si alguien está despedido. */
export type EstadoPerfil = {
  status: string;
  termination_date?: string | null;
};

/**
 * Despedido = `inactive` **Y** con fecha de baja.
 *
 * Un `inactive` a secas (licencia, pausa) NO es un despido: sigue en la
 * pestaña Empleados, que es donde su jefe lo busca (Daniela, 27/08/2026).
 * Esta es la única definición: <FiredBadge>, `firedNameClass`, la partición
 * Empleados/Despedidos y las sugerencias de warnings la llaman a ella.
 */
export function estaDespedido(p: EstadoPerfil | null | undefined): boolean {
  return !!p && p.status === 'inactive' && !!p.termination_date;
}

/** Activo de verdad: ni despedido ni en pausa. */
export function estaActivo(p: EstadoPerfil | null | undefined): boolean {
  return !!p && p.status === 'active';
}

/**
 * Sin salario cargado. `null` y `0` son la misma cosa ACÁ y solo acá: el
 * checklist de RRHH (Kevin, 2026-08-28) busca a quién le falta el dato, y un
 * salario cargado en cero es exactamente eso — falta cargarlo. En el resto del
 * módulo `null` ≠ `0` y se respeta (§1.3).
 */
export function sinSalario(p: { salary?: number | string | null }): boolean {
  const s = p.salary;
  return s == null || Number(s) === 0;
}
