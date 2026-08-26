import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { canAccessAnyModule, type ModuleKey } from '@/lib/modules';
import { TWOFA_COOKIE, twofaSealAvailable, verifyTwofaSeal } from '@/lib/auth/twofa-session';

export type { ModuleKey };

// ─────────────────────────────────────────────────────────────────────────────
// SELLO 2FA en la API
//
// El middleware sólo protege la navegación HTML (se saltea /api a propósito,
// por latencia). Sin este chequeo acá, el atacante que se fabrica una sesión
// contra GoTrue con la anon key no vería el dashboard… pero llamaría a
// /api/* y se llevaría los datos igual. El guardián tiene que estar en ambos.
//
// Costo: CERO consultas extra. `twofa_enabled` viaja en el mismo select del
// perfil que estas funciones ya hacían.
//
// Falla ABIERTO cuando no se puede aplicar (sin clave HMAC o kill switch) y
// CERRADO —401— sólo cuando sabemos con certeza que el usuario tiene 2FA
// habilitado y no hay sello válido. El 401 hace que el cliente reaccione
// como ante cualquier sesión vencida; la navegación siguiente choca con el
// middleware, que lo manda a /login a repetir el PIN.
// ─────────────────────────────────────────────────────────────────────────────
async function enforceTwofaSeal(
  authUserId: string,
  twofaEnabled: boolean | null | undefined,
): Promise<NextResponse | null> {
  if (!twofaEnabled) return null;
  if (!twofaSealAvailable()) return null;
  const store = await cookies();
  const ok = await verifyTwofaSeal(store.get(TWOFA_COOKIE)?.value, authUserId);
  if (ok) return null;
  return NextResponse.json(
    { success: false, error: 'Sesión sin verificación de 2FA. Volvé a iniciar sesión.' },
    { status: 401 },
  );
}

// Roles allowed to call /api/admin/* routes (fallback histórico).
//
// AUDITORÍA 2026-08-06 (hallazgo A2): este set único era el ÚNICO control de
// casi toda /api/admin/*, así que `hr` podía escribir egresos y órdenes de
// pago, y `auditor` podía borrar perfiles de RRHH con su histórico de
// comisiones. La exclusión de HR de las finanzas era solo de UI.
//
// Ahora cada ruta declara su dominio con `roles:`. Este fallback se mantiene
// para las rutas de lectura genéricas que aún no lo pasan.
const ADMIN_ROLES = ['admin', 'auditor', 'hr'];

// Los dominios (FINANCE_ROLES/HR_ROLES) viven en roles.ts — registro único
// que también lee la UI para no dibujar botones que este archivo rechazaría.
export { FINANCE_ROLES, HR_ROLES } from '@/lib/roles';

// ─────────────────────────────────────────────────────────────────────────────
// Guard de MÓDULOS en la API
//
// AUDITORÍA: hasta acá el guard de módulos era 100% cosmético —
// `module-route-guard.tsx` y `use-module-access.ts` son componentes CLIENTE, y
// ninguna ruta de API miraba `company_users.allowed_modules` ni
// `companies.active_modules`. Un `fetch('/api/admin/payment-orders', {method:
// 'POST'})` desde la consola del navegador entraba igual con el módulo
// desactivado para el usuario O para toda la empresa.
//
// Ahora cada ruta declara su módulo con `modules:` y la decisión la toma
// `canAccessModule` en src/lib/modules.ts — el MISMO helper que usa
// `hasModuleAccess` en el cliente, para que el botón que la UI dibuja y la
// ruta que el servidor acepta no puedan divergir.
//
// Semántica de la lista: OR. Una ruta que alimenta varias pantallas pasa si el
// caller tiene AL MENOS UNO de sus módulos. Sin `modules:` no hay chequeo, así
// que las rutas transversales (auth, notificaciones, idioma, health, cron) y
// cualquier call site viejo se comportan EXACTAMENTE igual que antes.
// ─────────────────────────────────────────────────────────────────────────────

export type ModuleGateOptions = {
  /**
   * Módulos que habilitan esta ruta. Pasa quien tenga acceso a alguno.
   * Omitir = ruta transversal, sin chequeo de módulo (conducta histórica).
   */
  modules?: readonly ModuleKey[];
};

type ModuleGateSubject = {
  role: string;
  isSuperadmin: boolean;
  allowedModules: string[] | null;
};

/**
 * Aplica el guard de módulos. Devuelve `null` si pasa, o el 403 a devolver.
 *
 * Cuesta UNA query extra a `companies` y SOLO cuando la ruta declara módulos:
 * `allowed_modules` viaja en el mismo select de `company_users` que ya se hace.
 * Falla CERRADO: si la empresa no se puede leer, no se entra.
 */
async function enforceModules(
  supabase: Awaited<ReturnType<typeof createClient>>,
  companyId: string,
  subject: ModuleGateSubject,
  opts?: ModuleGateOptions,
): Promise<NextResponse | null> {
  const modules = opts?.modules;
  if (!modules || modules.length === 0) return null;

  const { data: company } = await supabase
    .from('companies')
    .select('active_modules, business_model')
    .eq('id', companyId)
    .maybeSingle();

  if (!company) {
    return NextResponse.json(
      { success: false, error: 'Empresa no encontrada' },
      { status: 403 },
    );
  }

  const ok = canAccessAnyModule(modules, {
    role: subject.role,
    isSuperadmin: subject.isSuperadmin,
    allowedModules: subject.allowedModules,
    // `null` = no restringir a nivel tenant. Solo pasa si la columna está
    // vacía en la DB (empresas anteriores a la feature); un array vacío SÍ
    // bloquea, igual que en el cliente.
    activeModules: Array.isArray(company.active_modules) ? company.active_modules : null,
    businessModel: company.business_model,
  });

  if (!ok) {
    // Mensaje deliberadamente genérico: no revela si el módulo está apagado
    // para el usuario, para la empresa o por el modelo de negocio.
    return NextResponse.json(
      { success: false, error: 'Módulo no habilitado para este usuario' },
      { status: 403 },
    );
  }

  return null;
}


// ─────────────────────────────────────────────────────────────────────────────
// Quién puede llamar a una ruta: LEER y ESCRIBIR no son la misma pregunta.
//
// ── EL BUG QUE ESTO ARREGLA ────────────────────────────────────────────────
// El gate de rol se aplicaba a TODOS los métodos, así que `socio` —que nunca
// estuvo en ADMIN_ROLES— era rechazado antes de llegar al gate de módulos.
// Resultado: el rol era decorativo. Un socio con todos los módulos marcados
// veía el menú completo y cada pantalla le devolvía 403.
//
// No era teórico: Sergio (socio de Vex Pro) entró el 2026-08-22 con seis
// módulos marcados y no pudo leer ninguno. Y la doctrina escrita en roles.ts
// —"los allowed_modules controlan QUÉ VE un usuario"— era simplemente falsa.
//
// ── LA REGLA ───────────────────────────────────────────────────────────────
// · ESCRIBIR  → decide el ROL. Sin cambios: FINANCE_ROLES, HR_ROLES o el
//               fallback admin/auditor/hr. Nadie gana escritura con esto.
// · LEER      → decide el MÓDULO. Cualquier miembro de la empresa puede leer
//               lo que un admin le marcó en `allowed_modules`, y sólo eso.
//
// ── LAS TRES PUERTAS QUE NO SE ABREN ───────────────────────────────────────
// 1. `requireAdmin` gana siempre: el ciclo de vida de usuarios sigue siendo
//    sólo de admins, se lea o se escriba.
// 2. Sin módulos declarados NO se relaja. Si no hay módulo, el gate de módulos
//    no filtra nada y relajar el rol dejaría la ruta abierta a cualquiera.
//    `list-company-users` es exactamente ese caso.
// 3. Sin `request` no se relaja: sin método no se puede saber si es lectura, y
//    ante la duda se aplica lo estricto (`api-credentials` llama así).
// ─────────────────────────────────────────────────────────────────────────────

/** Métodos que sólo leen. TODO lo demás se trata como escritura. */
const METODOS_DE_LECTURA = new Set(['GET', 'HEAD']);

export function puedeLlamarRuta(params: {
  role: string;
  /** Método HTTP. `null` cuando la ruta llamó sin request: se asume escritura. */
  method: string | null;
  /** Roles que la ruta declara para ESCRIBIR. */
  allowed: readonly string[];
  /** ¿La ruta declara al menos un módulo? */
  declaresModules: boolean;
  requireAdmin?: boolean;
}): boolean {
  const { role, method, allowed, declaresModules, requireAdmin } = params;

  if (requireAdmin) return role === 'admin';
  if (allowed.includes(role)) return true;

  const esLectura = method !== null && METODOS_DE_LECTURA.has(method.toUpperCase());
  return esLectura && declaresModules;
}

export type VerifyAdminAuthOptions = ModuleGateOptions & {
  /**
   * When true, only callers with role 'admin' pass. Platform superadmins
   * (who act as role 'admin' inside the target tenant) also pass.
   * Auditor / hr are rejected with 403. Use for user-lifecycle endpoints
   * (reset password, delete user, reset 2FA, update auth user).
   */
  requireAdmin?: boolean;
  /**
   * Set de roles que pueden llamar ESTA ruta (además del superadmin, que
   * siempre pasa como 'admin'). Usar FINANCE_ROLES o HR_ROLES; sin esto se
   * cae al fallback histórico admin/auditor/hr.
   */
  roles?: readonly string[];
};

export type AuthInfo = {
  userId: string;
  companyId: string;
  role: string;
  name: string;
  email: string;
  /** True when the caller is a platform superadmin acting on a tenant. */
  isSuperadmin?: boolean;
};

/**
 * When the caller is a platform superadmin, company_id se lee ÚNICAMENTE del
 * query string (?company_id=...). El body NO se mira: leerlo obligaría a
 * consumir el stream de la request y las rutas ya no podrían hacer
 * `await request.json()` después. Si un endpoint necesita que el superadmin
 * apunte a un tenant, la URL debe llevar `?company_id=<id>` aunque el body
 * repita el dato — mandarlo solo en el body devuelve 400.
 *
 * Returns the resolved companyId string or null if not provided.
 */
function readCompanyIdFromRequest(request: NextRequest | undefined): string | null {
  if (!request) return null;
  const q = request.nextUrl.searchParams.get('company_id');
  if (q) return q;
  return null;
}

/**
 * Verify the caller of an /api/admin/* route is authenticated, belongs to a
 * company, and has a privileged role (admin / auditor / hr).
 *
 * Returns the caller's profile on success or an error NextResponse.
 *
 * Platform superadmins are allowed through with `role='admin'` when they
 * target a tenant via ?company_id=<id>. This keeps the "viewing as" flow
 * working for admin-only endpoints (e.g. /api/admin/api-credentials,
 * and the per-provider /api/integrations/<provider>/ping health checks).
 *
 * Pass `{ requireAdmin: true }` to restrict the endpoint to strict admins:
 * auditor / hr are rejected with 403 while the superadmin path keeps working
 * (superadmins already act as role 'admin' inside the target tenant).
 *
 * Pass `{ modules: ['payment_orders'] }` para exigir además el MÓDULO (ver
 * ModuleGateOptions). El rol dice QUÉ puede hacer; el módulo, SOBRE QUÉ. Sin
 * la opción, la conducta es exactamente la histórica.
 */
export async function verifyAdminAuth(
  request?: NextRequest,
  opts?: VerifyAdminAuthOptions,
): Promise<AuthInfo | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json(
      { success: false, error: 'No autenticado' },
      { status: 401 },
    );
  }

  // Superadmin shortcut — same pattern as verifyAuth.
  const { data: pu } = await supabase
    .from('platform_users')
    .select('id, name, email, twofa_enabled')
    .eq('user_id', user.id)
    .maybeSingle();

  if (pu) {
    const sealGate = await enforceTwofaSeal(user.id, pu.twofa_enabled);
    if (sealGate) return sealGate;
    const targetCompanyId = readCompanyIdFromRequest(request);
    if (!targetCompanyId) {
      return NextResponse.json(
        { success: false, error: 'Superadmin debe especificar empresa (?company_id=...)' },
        { status: 400 },
      );
    }
    // El bypass del superadmin NO salta el modelo de negocio (mismo orden que
    // hasModuleAccess): pedirle órdenes de pago a una entidad que no las tiene
    // sigue siendo 403.
    const gate = await enforceModules(
      supabase,
      targetCompanyId,
      { role: 'admin', isSuperadmin: true, allowedModules: null },
      opts,
    );
    if (gate) return gate;
    return {
      userId: user.id,
      companyId: targetCompanyId,
      role: 'admin',
      name: pu.name ?? '',
      email: pu.email ?? user.email ?? '',
      isSuperadmin: true,
    };
  }

  // Fetch the caller's company profile — uses RLS (anon key + cookie JWT),
  // so only rows the user can see are returned. `allowed_modules` viaja en
  // este mismo select: el guard de módulos no agrega una query por usuario.
  const { data: profile } = await supabase
    .from('company_users')
    .select('company_id, role, name, email, allowed_modules, twofa_enabled')
    .eq('user_id', user.id)
    .single();

  if (!profile) {
    return NextResponse.json(
      { success: false, error: 'Usuario sin empresa asignada' },
      { status: 403 },
    );
  }

  const sealGate = await enforceTwofaSeal(user.id, profile.twofa_enabled);
  if (sealGate) return sealGate;

  const allowed = opts?.roles ?? ADMIN_ROLES;
  if (
    !puedeLlamarRuta({
      role: profile.role,
      method: request?.method ?? null,
      allowed,
      declaresModules: (opts?.modules?.length ?? 0) > 0,
      requireAdmin: opts?.requireAdmin,
    })
  ) {
    // El mensaje distingue los dos casos: "no tenés el rol" y "no tenés el
    // módulo" mandan a arreglar cosas distintas.
    const esLectura = ['GET', 'HEAD'].includes((request?.method ?? '').toUpperCase());
    return NextResponse.json(
      {
        success: false,
        error: opts?.requireAdmin
          ? 'Solo administradores pueden realizar esta acción'
          : esLectura
            ? 'No tenés acceso a este módulo'
            : `Permiso insuficiente — se requiere rol ${allowed.join(' o ')}`,
      },
      { status: 403 },
    );
  }

  const gate = await enforceModules(
    supabase,
    profile.company_id,
    {
      role: profile.role,
      isSuperadmin: false,
      allowedModules: Array.isArray(profile.allowed_modules) ? profile.allowed_modules : null,
    },
    opts,
  );
  if (gate) return gate;

  return {
    userId: user.id,
    companyId: profile.company_id,
    role: profile.role,
    name: profile.name ?? '',
    email: profile.email ?? user.email ?? '',
  };
}

export type SuperadminAuthInfo = {
  userId: string;
  platformUserId: string;
  name: string;
  email: string;
};

/**
 * Verify the caller of an /api/superadmin/* route is an authenticated
 * Horizon platform superadmin (row in `platform_users`).
 *
 * Returns the caller's platform profile on success or an error NextResponse.
 */
export async function verifySuperadminAuth(): Promise<SuperadminAuthInfo | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json(
      { success: false, error: 'No autenticado' },
      { status: 401 },
    );
  }

  const { data: pu } = await supabase
    .from('platform_users')
    .select('id, name, email, twofa_enabled')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!pu) {
    return NextResponse.json(
      { success: false, error: 'Acceso restringido — se requiere superadmin' },
      { status: 403 },
    );
  }

  const sealGate = await enforceTwofaSeal(user.id, pu.twofa_enabled);
  if (sealGate) return sealGate;

  return {
    userId: user.id,
    platformUserId: pu.id,
    name: pu.name ?? '',
    email: pu.email ?? user.email ?? '',
  };
}

/**
 * Verify the caller is authenticated and belongs to a company — any role.
 * Use for read-only endpoints that all company members can access
 * (e.g. movements, balances).
 *
 * When passed a NextRequest, platform superadmins may target any tenant by
 * appending `?company_id=<id>` to the URL. This allows the "viewing as admin"
 * flow in /superadmin to hit tenant-scoped endpoints. Regular users ignore
 * the query param and resolve their company from `company_users` as before.
 *
 * `opts.modules` agrega el guard de módulos (ver ModuleGateOptions). Sin esa
 * opción el comportamiento es idéntico al histórico.
 */
export async function verifyAuth(
  request?: NextRequest,
  opts?: ModuleGateOptions,
): Promise<AuthInfo | NextResponse> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json(
      { success: false, error: 'No autenticado' },
      { status: 401 },
    );
  }

  // Superadmin path — no row in company_users, but can target any tenant.
  const { data: pu } = await supabase
    .from('platform_users')
    .select('id, name, email, twofa_enabled')
    .eq('user_id', user.id)
    .maybeSingle();

  if (pu) {
    const sealGate = await enforceTwofaSeal(user.id, pu.twofa_enabled);
    if (sealGate) return sealGate;
    const targetCompanyId = readCompanyIdFromRequest(request);
    if (!targetCompanyId) {
      return NextResponse.json(
        { success: false, error: 'Superadmin debe especificar empresa (?company_id=...)' },
        { status: 400 },
      );
    }
    // El modelo de negocio se aplica ANTES del bypass del superadmin.
    const gate = await enforceModules(
      supabase,
      targetCompanyId,
      { role: 'admin', isSuperadmin: true, allowedModules: null },
      opts,
    );
    if (gate) return gate;
    return {
      userId: user.id,
      companyId: targetCompanyId,
      role: 'admin', // superadmin acts with admin privileges inside the target tenant
      name: pu.name ?? '',
      email: pu.email ?? user.email ?? '',
      isSuperadmin: true,
    };
  }

  // Regular user path. `allowed_modules` viaja en el mismo select.
  const { data: profile } = await supabase
    .from('company_users')
    .select('company_id, role, name, email, allowed_modules, twofa_enabled')
    .eq('user_id', user.id)
    .single();

  if (!profile) {
    return NextResponse.json(
      { success: false, error: 'Usuario sin empresa asignada' },
      { status: 403 },
    );
  }

  const sealGate = await enforceTwofaSeal(user.id, profile.twofa_enabled);
  if (sealGate) return sealGate;

  const gate = await enforceModules(
    supabase,
    profile.company_id,
    {
      role: profile.role,
      isSuperadmin: false,
      allowedModules: Array.isArray(profile.allowed_modules) ? profile.allowed_modules : null,
    },
    opts,
  );
  if (gate) return gate;

  return {
    userId: user.id,
    companyId: profile.company_id,
    role: profile.role,
    name: profile.name ?? '',
    email: profile.email ?? user.email ?? '',
  };
}
