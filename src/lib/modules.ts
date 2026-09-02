// ─────────────────────────────────────────────────────────────────────────────
// Registro ÚNICO de módulos de la plataforma.
//
// Antes esta lista existía cuatro veces —  ALL_MODULES y MODULE_LABELS en
// auth-context, VALID_MODULE_KEYS en /api/admin/update-company-user y MODULES
// en el formulario de empresa del superadmin — y se desincronizaron:
//
//   · `payment_orders` faltaba en MODULE_LABELS → en /usuarios el chip
//     mostraba la clave cruda y el panel de roles ni siquiera lo ofrecía.
//   · `ib_rebates` faltaba en VALID_MODULE_KEYS → el endpoint lo DESCARTABA
//     al guardar. Seis usuarios ya lo tenían asignado y lo perdían en
//     silencio la próxima vez que alguien editara su ficha.
//
// Por eso la lista vive acá y todos importan de este archivo. Agregar un
// módulo es agregar una fila; no hay una segunda lista que actualizar.
//
// Import-safe desde cliente y servidor: no toca Supabase ni React.
// ─────────────────────────────────────────────────────────────────────────────

import { moduleAllowedForModel } from '@/lib/business-model';
import { roleCanWrite } from '@/lib/roles';

export interface ModuleDef {
  key: string;
  labelEs: string;
  labelEn: string;
  /**
   * Submódulo: se asigna por separado en allowed_modules pero vive dentro de
   * la pantalla de otro módulo (hoy solo `ib_rebates`, una pestaña de RRHH).
   * No aparece como destino propio en el menú.
   */
  parent?: string;
  /**
   * El módulo existe SÓLO en las empresas que lo tienen activado — superadmin
   * incluido.
   *
   * El superadmin normalmente ve todos los módulos en todas las empresas
   * (`canAccessModule`, paso 2), y para casi todos está bien: son módulos que
   * cualquier empresa podría tener. Pero algunos viven en UNA empresa por
   * diseño, y el bypass los mostraba en el sidebar de todas, dando a entender
   * que cada empresa tenía el suyo.
   *
   * Con esta marca, `active_modules` manda también sobre el superadmin. No es
   * una regla de seguridad —la escritura la siguen decidiendo el rol y los
   * endpoints— sino de ubicación: que el menú diga la verdad sobre dónde vive
   * el módulo.
   */
  onlyWhereActivated?: boolean;
}

const MODULE_DEFS = [
  { key: 'summary',        labelEs: 'Resumen',            labelEn: 'Summary' },
  { key: 'movements',      labelEs: 'Movimientos',        labelEn: 'Movements' },
  { key: 'expenses',       labelEs: 'Egresos',            labelEn: 'Expenses' },
  { key: 'income',         labelEs: 'Ingresos',           labelEn: 'Income' },
  { key: 'liquidity',      labelEs: 'Liquidez',           labelEn: 'Liquidity' },
  // Pool de liquidez sobre cuentas MT5. NO reemplaza a `liquidity`: aquél es la
  // conciliación que ya usa Vex Pro, con sus propias tablas. Éste lee MT5 y
  // calcula cuánto hay que reservar, descontando la plata que un mismo cliente
  // mueve entre cuentas propias. Son módulos distintos y conviven.
  // `onlyWhereActivated`: vive en la empresa administradora y desde ahí se
  // elige a qué empresa mirarle el pool. Sin esta marca el bypass de superadmin
  // lo dibujaba en el sidebar de TODAS las empresas, y ahí se leía como si cada
  // una tuviera su propio pool — cuando en realidad era siempre la misma
  // pantalla con un selector adentro.
  { key: 'liquidity_pool', labelEs: 'Pool de Liquidez',   labelEn: 'Liquidity Pool',
    onlyWhereActivated: true },
  { key: 'investments',    labelEs: 'Inversiones',        labelEn: 'Investments' },
  { key: 'balances',       labelEs: 'Balances',           labelEn: 'Balances' },
  { key: 'partners',       labelEs: 'Socios',             labelEn: 'Partners' },
  { key: 'clients',        labelEs: 'Clientes',           labelEn: 'Clients' },
  { key: 'payment_orders', labelEs: 'Órdenes de Pago',    labelEn: 'Payment Orders' },
  { key: 'upload',         labelEs: 'Carga de Datos',     labelEn: 'Data Upload' },
  { key: 'periods',        labelEs: 'Períodos',           labelEn: 'Periods' },
  { key: 'reports',        labelEs: 'Reportes',           labelEn: 'Reports' },
  { key: 'hr',             labelEs: 'Recursos Humanos',   labelEn: 'Human Resources' },
  { key: 'ib_rebates',     labelEs: 'Configuración IBs',  labelEn: 'IB Settings', parent: 'hr' },
  { key: 'commissions',    labelEs: 'Comisiones',         labelEn: 'Commissions' },
  { key: 'risk',           labelEs: 'Gestión de Riesgo',  labelEn: 'Risk Management' },
  // Hedge Fund (migración 125). Es un producto de INVERSIÓN que venden los
  // brokers del grupo, con sus propias colecciones en el CRM: programa,
  // inversión por cliente, libro, corridas de pago y comisiones de red.
  //
  // NO es `investments`, aunque la palabra se parezca: aquél es la tabla que
  // el propio equipo carga a mano con el rendimiento de sus inversiones
  // (/inversiones es de solo lectura y /upload la escribe). Éste es dinero DE
  // CLIENTES espejado del CRM y no se carga a mano en ningún lado. Confundirlos
  // sería el mismo error que el comentario de `liquidity_pool` ya advierte.
  //
  // Sin `onlyWhereActivated`: a diferencia del pool, esto NO vive en una sola
  // empresa. Lo tienen las dos que son `broker` —Vex Pro y AP Markets— y lo
  // que decide si se ve es el MODELO DE NEGOCIO (business-model.ts:
  // `hedgeFund`), que además bloquea al superadmin.
  { key: 'hedge_fund',     labelEs: 'Hedge Fund',         labelEn: 'Hedge Fund' },
  { key: 'users',          labelEs: 'Usuarios',           labelEn: 'Users' },
  { key: 'logs',           labelEs: 'Registro de Actividad', labelEn: 'Activity Log' },
  // Migración 100 — el asistente de IA. Es de SOLO LECTURA por construcción:
  // sus herramientas no escriben nada, y cada una vuelve a preguntar por el
  // módulo que necesita. Por eso alcanza con tener este módulo asignado; lo
  // que la persona puede LEER por el chat sigue siendo exactamente lo que
  // podría leer por pantalla.
  { key: 'assistant',      labelEs: 'Asistente IA',       labelEn: 'AI Assistant' },
] as const satisfies readonly ModuleDef[];

/**
 * Unión de las claves reales, derivada de la MISMA lista: pasar un módulo
 * inventado a `verifyAuth({ modules: [...] })` no compila.
 */
export type ModuleKey = (typeof MODULE_DEFS)[number]['key'];

export const MODULES: ModuleDef[] = MODULE_DEFS.map((m) => ({ ...m }));

/** Índice por clave, derivado de la MISMA lista. `canAccessModule` corre en
 *  cada ítem del sidebar en cada render: buscar con `.find()` ahí dentro sería
 *  recorrer las ~30 filas por ítem. */
const MODULE_BY_KEY = new Map<string, ModuleDef>(MODULES.map((m) => [m.key, m]));

/**
 * `audit` NO está en la lista: es exclusivo del superadmin y hasModuleAccess
 * lo rechaza siempre, incluso para un admin de empresa. Se audita desde
 * /superadmin/companies/[id].
 *
 * `settings` tampoco: quedó de cuando existía el grupo "Configuraciones" en
 * el menú. Ningún usuario lo tiene asignado (verificado en producción) y no
 * hay ninguna pantalla detrás.
 */
export const RESERVED_MODULE_KEYS = ['audit', 'settings'] as const;

/**
 * Módulos con los que NACE una empresa nueva. Fuente ÚNICA: la consumen el
 * endpoint de alta (POST /api/superadmin/companies) y el formulario del
 * superadmin (/superadmin/companies/new). Antes eran dos literales gemelos
 * que nadie sincronizaba, y a los dos les faltaba lo mismo:
 *
 *   · `users` → el admin de la empresa NO podía entrar a /usuarios: el guard
 *     de módulos corta por `active_modules` incluso para el rol admin, así
 *     que la empresa quedaba sin forma de administrar su propia gente.
 *   · `logs`  → sin Registro de Actividad, o sea sin rastro visible.
 *   · `reports` → src/lib/reports/send.ts solo le manda el reporte diario a
 *     las empresas que lo tienen; sin él ni la empresa ni el superadmin
 *     recibían NADA (le pasó a Horizon, verificado en producción).
 *   · `clients` → la ficha de clientes que alimenta ingresos y comisiones.
 *
 * Lo que NO entra por default y se habilita a mano: `hr` (+ su submódulo
 * `ib_rebates`), `commissions` y `risk` — son módulos que se contratan.
 *
 * Ojo: esto es el default del ALTA. El modelo de negocio sigue mandando
 * (blockedModules), así que una entidad 'company' no ve movements/liquidity/
 * investments aunque figuren acá.
 */
export const DEFAULT_ACTIVE_MODULES: string[] = [
  'summary',
  'movements',
  'expenses',
  'income',
  'liquidity',
  'investments',
  'balances',
  'partners',
  'clients',
  'payment_orders',
  'upload',
  'periods',
  'reports',
  'users',
  'logs',
];

export const MODULE_KEYS: string[] = MODULES.map((m) => m.key);

/** Para validar payloads: cualquier clave fuera de acá se descarta. */
export const MODULE_KEY_SET: ReadonlySet<string> = new Set(MODULE_KEYS);

/** Etiquetas en español — las consume la UI del dashboard. */
export const MODULE_LABELS: Record<string, string> = Object.fromEntries(
  MODULES.map((m) => [m.key, m.labelEs]),
);

export function moduleLabel(key: string, locale: 'es' | 'en' = 'es'): string {
  const def = MODULES.find((m) => m.key === key);
  if (!def) return key;
  return locale === 'en' ? def.labelEn : def.labelEs;
}

export function isValidModuleKey(key: string): boolean {
  return MODULE_KEY_SET.has(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisión de acceso a un módulo — helper PURO, única fuente de verdad.
//
// AUDITORÍA: el guard de módulos era puramente COSMÉTICO. `hasModuleAccess`
// (cliente) decidía qué se dibuja, pero NINGUNA ruta de API miraba
// `allowed_modules` ni `active_modules`: un fetch desde la consola del
// navegador entraba igual con el módulo apagado. Ahora `verifyAuth` /
// `verifyAdminAuth` (src/lib/api-auth.ts) llaman a ESTA función con los datos
// que traen de la DB, y `hasModuleAccess` la llama con los del contexto de
// React. La regla vive en un solo lugar a propósito: listas duplicadas que se
// desincronizan en silencio son el modo de falla número uno de este repo.
//
// El ORDEN de los chequeos es parte del contrato y replica el que ya tenía el
// cliente:
//   1. modelo de negocio  → bloquea INCLUSO al superadmin (una consultora no
//      tiene "riesgo" ni "movimientos" por más superadmin que seas).
//   2. bypass superadmin  → pasa el resto.
//   3. módulos reservados → `audit` es exclusivo de /superadmin.
//   4. chequeo de usuario → admin de empresa pasa sin mirar allowed_modules.
//   5. chequeo de tenant  → active_modules, si se proporcionó.
// ─────────────────────────────────────────────────────────────────────────────

export interface ModuleAccessContext {
  /** Rol efectivo dentro de la empresa ('admin', 'auditor', 'hr', custom…). */
  role?: string | null;
  /** True para un superadmin de plataforma (bypass del punto 2). */
  isSuperadmin?: boolean;
  /** `company_users.allowed_modules` del caller. */
  allowedModules?: readonly string[] | null;
  /**
   * `companies.active_modules`. `null`/`undefined` = no se comprueba el nivel
   * tenant (lo que hace la UI cuando todavía no cargó la empresa). Un array
   * VACÍO sí bloquea: es una empresa sin módulos habilitados.
   */
  activeModules?: readonly string[] | null;
  /** `companies.business_model` — ver `BusinessModel` en business-model.ts. */
  businessModel?: unknown;
}

export function canAccessModule(module: string, ctx: ModuleAccessContext): boolean {
  // 1. El modelo de negocio manda sobre todo, superadmin incluido.
  if (!moduleAllowedForModel(ctx.businessModel, module)) return false;

  // 1b. Módulos que viven en UNA empresa por diseño: `active_modules` manda
  // también sobre el superadmin. Va ANTES del bypass, como la regla del modelo
  // de negocio, porque si no el módulo aparecería en el sidebar de todas las
  // empresas para quien administra la plataforma.
  //
  // Sólo cuando `activeModules` llegó: `undefined` es "todavía no cargó", no
  // "no lo tiene". Tratarlos igual haría desaparecer el módulo mientras la
  // empresa está en vuelo, y volvería a aparecer después — un parpadeo que se
  // lee como un bug.
  if (ctx.activeModules && !ctx.activeModules.includes(module)) {
    const def = MODULE_BY_KEY.get(module);
    if (def?.onlyWhereActivated) return false;
  }

  // 2. Superadmin de plataforma: ve el resto sin filtros de tenant.
  if (ctx.isSuperadmin) return true;

  // 3. Reservados del superadmin — ni un admin de empresa entra.
  if ((RESERVED_MODULE_KEYS as readonly string[]).includes(module)) return false;

  // 3b. La carga de datos SÓLO existe para escribir.
  //
  // Un rol de solo lectura ahí dentro no puede hacer nada: ve formularios que
  // el servidor le va a rechazar con 403. Se bloquea por rol y no fila por
  // fila porque ya se le escapó a alguien — los dos socios de Vex Pro tenían
  // el módulo quitado a mano y los siete de AP Markets no, sin que la
  // diferencia respondiera a ninguna decisión.
  if (module === 'upload' && !roleCanWrite(ctx.role ?? '')) return false;

  // 4. Nivel usuario: el admin de empresa pasa sin mirar su lista.
  const passesUserCheck =
    ctx.role === 'admin' || (ctx.allowedModules?.includes(module) ?? false);
  if (!passesUserCheck) return false;

  // 5. Nivel tenant: el módulo tiene que estar contratado por la empresa.
  if (ctx.activeModules && !ctx.activeModules.includes(module)) return false;

  return true;
}

/**
 * Variante OR para rutas que sirven a varios módulos a la vez (p.ej.
 * /api/admin/data alimenta el resumen entero). Con la lista vacía devuelve
 * `true` — "sin módulo declarado" significa ruta transversal.
 */
export function canAccessAnyModule(
  modules: readonly string[],
  ctx: ModuleAccessContext,
): boolean {
  if (modules.length === 0) return true;
  return modules.some((m) => canAccessModule(m, ctx));
}

/** Filtra un payload dejando solo claves conocidas, sin duplicados. */
export function sanitizeModuleKeys(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw === 'string' && MODULE_KEY_SET.has(raw)) seen.add(raw);
  }
  return [...seen];
}

/**
 * Rótulo que VE la empresa para un módulo. Hoy el único módulo con nombre
 * comercial propio es `hedge_fund` (Vex Pro lo vende como «Vex Capital»,
 * migración 126). Se resuelve acá, en el registro, para que el menú, el título
 * de la pantalla y cualquier pantalla futura digan lo mismo — si cada uno
 * consultara la columna por su cuenta, uno se olvidaría.
 */
export function moduleDisplayLabel(
  moduleKey: string,
  fallback: string,
  company: { hedge_fund_label?: string | null } | null | undefined,
): string {
  if (moduleKey === 'hedge_fund') {
    const custom = company?.hedge_fund_label?.trim();
    if (custom) return custom;
  }
  return fallback;
}
