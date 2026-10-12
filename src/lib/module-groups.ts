import {
  LayoutDashboard,
  BarChart3,
  ArrowLeftRight,
  Receipt,
  Droplets,
  TrendingUp,
  LineChart,
  Users as UsersIcon,
  Upload,
  CalendarDays,
  Wallet,
  Calculator,
  ShieldAlert,
  Activity,
  FileSearch,
  Briefcase,
  FileText,
  FileSignature,
  Table,
  ScrollText,
  Contact,
  Database,
  Sparkles,
  Landmark,
  UserCog,
  type LucideIcon,
} from 'lucide-react';
import { hasModuleAccess, type User } from '@/lib/auth-context';
import type { ModuleKey } from '@/lib/modules';

// ─────────────────────────────────────────────────────────────────────────────
// Registro ÚNICO de navegación: qué pantallas hay, con qué icono, en qué grupo
// y detrás de qué módulo.
//
// POR QUÉ (2026-10-12, Fase 4 «Libro mayor»): la navegación existía TRES
// veces —`NAV_STRUCTURE` en sidebar.tsx, `MODULE_GROUPS` acá y `ENTRIES` en
// _home/quick-access.tsx— y ya se habían desincronizado en silencio:
//
//   · Forecast (`/finanzas/forecast`) y Registro de Actividad (`/logs`) no
//     estaban en MODULE_GROUPS. El sidebar en modo «plano» (usuario no-admin
//     con UN solo grupo) se dibujaba desde MODULE_GROUPS, así que un usuario
//     sólo-Finanzas con `reports` NO veía Forecast en el menú, aunque la
//     pantalla le respondía si escribía la URL.
//   · El rail contraído en modo plano sacaba el icono de un mapa derivado de
//     NAV_STRUCTURE con `?? Circle` de respaldo: un destino nuevo en un solo
//     lado salía con un círculo genérico.
//   · Accesos rápidos tenía sus propios rótulos en castellano fijo (sin i18n)
//     y 14 colores de paleta cruda.
//
// Medición: 21 destinos en NAV_STRUCTURE, 19 en MODULE_GROUPS (faltaban 2),
// 14 en accesos rápidos (subconjunto elegido a mano, sin marca de cuál).
//
// Ahora hay UNA tabla (`NAV_ENTRIES`) y lo demás se deriva:
//   · el sidebar dibuja `NAV_GROUPS` + `NAV_ENTRIES` (src/components/sidebar.tsx),
//   · `MODULE_GROUPS` (dispatcher de la home y conteo de grupos) sale de acá,
//   · accesos rápidos filtra las entradas con `quickAccess: true`,
//   · la topbar saca las migas (grupo / pantalla) y si la pantalla usa el
//     período global (`usesPeriod`).
// `module-groups.test.ts` itera el registro de módulos y falla si un módulo
// con pantalla no tiene entrada, si una entrada apunta a una página que no
// existe, o si el guardián de rutas decide otro módulo para el mismo href.
//
// Descartado: poner esta tabla en modules.ts. Aquél es import-safe desde el
// SERVIDOR (lo usa api-auth en cada request) y no debe arrastrar iconos de
// React; éste ya era de cliente (importa auth-context).
//
// Lectura la decide el módulo: cada entrada declara su `module` y TODA
// visibilidad pasa por `hasModuleAccess` (rol + allowed_modules + active_modules
// + modelo de negocio). Escribir lo sigue decidiendo el rol en cada endpoint.
// ─────────────────────────────────────────────────────────────────────────────

export type ModuleGroupKey = 'finance' | 'hr' | 'risk' | 'config';

/**
 * Contadores de pendientes que el menú sabe dibujar (píldora `pend`). La app
 * todavía NO tiene estos números en ningún contexto compartido: el hueco queda
 * preparado (el sidebar recibe `pendingCounts`) y nadie lo llena hasta que
 * exista una fuente real. Un contador inventado es peor que ninguno.
 */
export type PendingCounterKey = 'paymentOrdersPending' | 'withdrawalsToReview';

export interface NavEntry {
  href: string;
  /** Clave i18n del rótulo (en `en` y `es`). */
  i18nKey: string;
  icon: LucideIcon;
  /** Módulo que decide si la pantalla se ve (lectura). */
  module: ModuleKey;
  /** Grupo del menú. `null` = fuera de grupo (sólo la home). */
  group: ModuleGroupKey | null;
  /** La pantalla lee el período global (PeriodContext): la topbar muestra el selector. */
  usesPeriod?: boolean;
  /** Aparece en la grilla de accesos rápidos de la home. */
  quickAccess?: boolean;
  /** Contador de pendientes que se dibuja al lado del rótulo, si llega. */
  pendingKey?: PendingCounterKey;
}

export interface NavGroupDef {
  key: ModuleGroupKey;
  i18nKey: string;
  icon: LucideIcon;
  /** Destino canónico del grupo (lo usa el dispatcher de la home). */
  homeHref: string;
}

export const NAV_GROUPS: readonly NavGroupDef[] = [
  { key: 'finance', i18nKey: 'nav.finance', icon: BarChart3, homeHref: '/resumen-general' },
  { key: 'hr', i18nKey: 'nav.hr', icon: UserCog, homeHref: '/rrhh/dashboard' },
  { key: 'risk', i18nKey: 'nav.risk', icon: ShieldAlert, homeHref: '/risk/dashboard' },
  // Usuarios, Registro y Asistente: transversales a los tres dominios. Siguen
  // siendo un «grupo» para que un usuario que sólo tiene uno de ellos cuente
  // como de un solo grupo (dispatcher).
  { key: 'config', i18nKey: 'nav.groupGeneral', icon: UsersIcon, homeHref: '/usuarios' },
];

export const NAV_ENTRIES: readonly NavEntry[] = [
  // Home adaptativa (una vista por rol; ver src/app/(dashboard)/page.tsx).
  { href: '/', i18nKey: 'nav.home', icon: LayoutDashboard, module: 'summary', group: null },

  // ── Finanzas ──
  { href: '/resumen-general', i18nKey: 'nav.generalSummary', icon: BarChart3, module: 'summary', group: 'finance', usesPeriod: true, quickAccess: true },
  { href: '/movimientos', i18nKey: 'nav.movements', icon: ArrowLeftRight, module: 'movements', group: 'finance', usesPeriod: true, quickAccess: true },
  { href: '/egresos', i18nKey: 'nav.expenses', icon: Receipt, module: 'expenses', group: 'finance', usesPeriod: true, quickAccess: true },
  // Consulta de ingresos operativos — el espejo de Egresos; la carga sigue
  // viviendo en «Carga de Datos».
  { href: '/ingresos', i18nKey: 'nav.income', icon: TrendingUp, module: 'income', group: 'finance', usesPeriod: true },
  { href: '/liquidez', i18nKey: 'nav.liquidity', icon: Droplets, module: 'liquidity', group: 'finance', quickAccess: true },
  { href: '/liquidez-pool', i18nKey: 'nav.liquidityPool', icon: Droplets, module: 'liquidity_pool', group: 'finance' },
  { href: '/inversiones', i18nKey: 'nav.investments', icon: TrendingUp, module: 'investments', group: 'finance', quickAccess: true },
  // El producto de inversión que el broker le vende a SUS clientes, espejado
  // del CRM. Va en Finanzas y no en Risk: contesta cuánto capital hay bajo
  // gestión y cuánto se le debe a los clientes — preguntas de plata. No
  // confundir con `investments` (cartera propia cargada a mano): ver el
  // comentario de `hedge_fund` en modules.ts.
  { href: '/hedge-fund', i18nKey: 'nav.hedgeFund', icon: Landmark, module: 'hedge_fund', group: 'finance' },
  { href: '/balances', i18nKey: 'nav.balances', icon: Wallet, module: 'balances', group: 'finance', usesPeriod: true, quickAccess: true },
  { href: '/socios', i18nKey: 'nav.partners', icon: Briefcase, module: 'partners', group: 'finance', usesPeriod: true, quickAccess: true },
  { href: '/clientes', i18nKey: 'nav.clients', icon: Contact, module: 'clients', group: 'finance' },
  { href: '/ordenes-pago', i18nKey: 'nav.paymentOrders', icon: FileSignature, module: 'payment_orders', group: 'finance', pendingKey: 'paymentOrdersPending' },
  { href: '/upload', i18nKey: 'nav.upload', icon: Upload, module: 'upload', group: 'finance', quickAccess: true },
  { href: '/periodos', i18nKey: 'nav.periods', icon: CalendarDays, module: 'periods', group: 'finance', quickAccess: true },
  { href: '/finanzas/reportes', i18nKey: 'nav.reports', icon: FileText, module: 'reports', group: 'finance' },
  // Tabla mes a mes con todos los indicadores (Kevin 2026-06-06). Misma
  // puerta que reports: ambas son vistas ejecutivas.
  { href: '/finanzas/consolidado', i18nKey: 'nav.consolidado', icon: Table, module: 'reports', group: 'finance' },
  // La única vista forward-looking (tanda 5 de la auditoría). Faltaba en
  // MODULE_GROUPS → invisible en el menú plano.
  { href: '/finanzas/forecast', i18nKey: 'nav.forecast', icon: LineChart, module: 'reports', group: 'finance' },
  // Totales que ya salen solos del CRM (P2P, ventas y retiros de prop firm).
  // Puerta 'income': quien la mira es quien carga los ingresos.
  { href: '/finanzas/crm', i18nKey: 'nav.crmTotals', icon: Database, module: 'income', group: 'finance' },

  // ── Recursos Humanos ──
  { href: '/rrhh/dashboard', i18nKey: 'nav.hrDashboard', icon: LayoutDashboard, module: 'hr', group: 'hr', usesPeriod: true, quickAccess: true },
  { href: '/rrhh', i18nKey: 'nav.hrManagement', icon: UsersIcon, module: 'hr', group: 'hr', quickAccess: true },
  { href: '/comisiones', i18nKey: 'nav.commissions', icon: Calculator, module: 'commissions', group: 'hr', quickAccess: true },

  // ── Risk ──
  // Primero el dashboard: es el aterrizaje de los roles sólo-riesgo (soporte).
  { href: '/risk/dashboard', i18nKey: 'nav.riskDashboard', icon: LayoutDashboard, module: 'risk', group: 'risk' },
  { href: '/risk/retiros-propfirm', i18nKey: 'nav.riskWithdrawals', icon: FileSearch, module: 'risk', group: 'risk', quickAccess: true },
  // La cola de retiros del CRM (reconstruida contra el espejo real, migración
  // 088; el viejo retiros-wallet era 100 % mock y se eliminó).
  { href: '/risk/retiros', i18nKey: 'nav.riskWithdrawalQueue', icon: ShieldAlert, module: 'risk', group: 'risk', pendingKey: 'withdrawalsToReview' },
  { href: '/risk/exposicion', i18nKey: 'nav.riskExposure', icon: Activity, module: 'risk', group: 'risk' },

  // ── General (transversal) ──
  // Auditoría NO está: vive sólo en el panel del superadmin.
  { href: '/usuarios', i18nKey: 'nav.users', icon: UsersIcon, module: 'users', group: 'config', quickAccess: true },
  // Aplica a los movimientos de TODOS los módulos, no de uno. Faltaba en
  // MODULE_GROUPS.
  { href: '/logs', i18nKey: 'nav.logs', icon: ScrollText, module: 'logs', group: 'config' },
  // Responde de finanzas, RRHH y riesgo a la vez: meterlo en un dominio
  // sugeriría un alcance que no tiene.
  { href: '/asistente', i18nKey: 'nav.assistant', icon: Sparkles, module: 'assistant', group: 'config' },
];

/** ¿`pathname` está en `href` o debajo? `/` sólo matchea exacto. */
export function isNavHrefActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

/**
 * La entrada que corresponde a una ruta: el href más largo que la contiene
 * (así `/rrhh/dashboard` gana sobre `/rrhh`, y `/movimientos/desglose/x`
 * cae en Movimientos). `null` = ruta fuera del menú (p. ej. /perfil).
 */
export function findNavEntry(pathname: string): NavEntry | null {
  let best: NavEntry | null = null;
  for (const e of NAV_ENTRIES) {
    if (!isNavHrefActive(e.href, pathname)) continue;
    if (!best || e.href.length > best.href.length) best = e;
  }
  return best;
}

export function navGroup(key: ModuleGroupKey | null): NavGroupDef | null {
  if (!key) return null;
  return NAV_GROUPS.find((g) => g.key === key) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE_GROUPS — vista derivada para el dispatcher de la home.
//
// «Cantidad de grupos» decide: cuando un usuario no-admin tiene acceso a
// grupos de Finanzas/RRHH/Risk, la home lo redirige al `homeHref` del primero
// (src/app/(dashboard)/page.tsx).
// ─────────────────────────────────────────────────────────────────────────────

export interface ModuleGroupItem {
  module: ModuleKey;
  href: string;
  i18nKey: string;
}

export interface ModuleGroup {
  key: ModuleGroupKey;
  /** Destino canónico del grupo (lo usa el dispatcher). */
  homeHref: string;
  i18nKey: string;
  items: ModuleGroupItem[];
}

export const MODULE_GROUPS: ModuleGroup[] = NAV_GROUPS.map((g) => ({
  key: g.key,
  homeHref: g.homeHref,
  i18nKey: g.i18nKey,
  items: NAV_ENTRIES.filter((e) => e.group === g.key).map((e) => ({
    module: e.module,
    href: e.href,
    i18nKey: e.i18nKey,
  })),
}));

/**
 * Grupos a los que el usuario puede entrar, dados su membresía y los
 * `active_modules` de la empresa. Un grupo entra si al menos uno de sus ítems
 * pasa `hasModuleAccess`.
 */
export function getAccessibleGroups(
  user: User | null,
  activeModules: string[] | null | undefined,
  businessModel?: unknown,
): ModuleGroup[] {
  if (!user) return [];
  return MODULE_GROUPS.filter((g) =>
    g.items.some((item) => hasModuleAccess(user, item.module, activeModules, businessModel)),
  );
}

/** Ítems de un grupo que el usuario puede ver. */
export function getAccessibleItems(
  user: User | null,
  group: ModuleGroup,
  activeModules: string[] | null | undefined,
  businessModel?: unknown,
): ModuleGroupItem[] {
  if (!user) return [];
  return group.items.filter((item) =>
    hasModuleAccess(user, item.module, activeModules, businessModel),
  );
}

/** Entradas del registro que el usuario puede ver, en el orden del menú. */
export function getAccessibleNavEntries(
  user: User | null,
  activeModules: string[] | null | undefined,
  businessModel?: unknown,
): NavEntry[] {
  if (!user) return [];
  return NAV_ENTRIES.filter((e) => hasModuleAccess(user, e.module, activeModules, businessModel));
}

// ─────────────────────────────────────────────────────────────────────────────
// Menú desplegable (2026-10-12, pedido del dueño: «el menú debe ser
// desplegable»). Lógica PURA del acordeón del sidebar; vive acá y no en el
// componente para poder probarla en el entorno node de vitest.
//
// POR QUÉ: Finanzas tiene 17 ítems y con rótulos fijos obligaba a scrollear
// para llegar a Risk o Configuración.
//
// Reglas:
//   · varios grupos abiertos a la vez (no es un acordeón exclusivo);
//   · el grupo de la ruta activa arranca abierto y se vuelve a abrir al
//     navegar hacia él; los demás vuelven como el usuario los dejó (storage
//     por usuario Y empresa: un superadmin «viendo como» otra empresa tiene
//     otros grupos habilitados);
//   · un grupo con un solo ítem accesible no colapsa: esconder el único
//     destino detrás de un clic extra sería puro costo;
//   · el contador de pendientes de un grupo CERRADO se suma junto al rótulo:
//     plegar no puede esconder un pendiente (fallo que no da error).
//
// Storage ilegible (JSON roto, tipo equivocado, claves desconocidas, storage
// bloqueado): se ignora y se arranca con sólo el activo abierto. «No hay
// nada guardado» (`null`) es distinto de «el usuario cerró todo» (`[]`).
//
// Descartado: acordeón exclusivo (obliga a cerrar uno para ver otro y pierde
// el contexto); guardar el estado en el servidor (es una preferencia de
// pantalla, no un dato de la empresa); impedir cerrar el grupo activo (si el
// usuario lo cierra a mano, lo decidió él).
// ─────────────────────────────────────────────────────────────────────────────

const GROUP_KEYS: readonly string[] = NAV_GROUPS.map((g) => g.key);

export function navOpenStorageKey(userId: string, companyId: string | null | undefined): string {
  return `nav-open-groups:${userId}:${companyId ?? 'none'}`;
}

/** Lo guardado, o `null` si no hay nada utilizable (ausente, roto, storage bloqueado). */
export function readOpenGroups(
  storage: Pick<Storage, 'getItem'> | null | undefined,
  key: string,
): ModuleGroupKey[] | null {
  try {
    const raw = storage?.getItem(key);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((k): k is ModuleGroupKey => typeof k === 'string' && GROUP_KEYS.includes(k));
  } catch {
    return null;
  }
}

/** Devuelve `false` si no se pudo guardar (storage lleno o bloqueado): nunca lanza. */
export function writeOpenGroups(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  key: string,
  open: Iterable<ModuleGroupKey>,
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify([...open]));
    return true;
  } catch {
    return false;
  }
}

/**
 * Grupos abiertos al arrancar: lo guardado (si hay) + SIEMPRE el grupo de la
 * ruta activa. Sin nada guardado, sólo el activo.
 */
export function initialOpenGroups(
  stored: readonly ModuleGroupKey[] | null,
  activeGroup: ModuleGroupKey | null,
): Set<ModuleGroupKey> {
  const open = new Set<ModuleGroupKey>(stored ?? []);
  if (activeGroup) open.add(activeGroup);
  return open;
}

/** Suma de los contadores > 0 de las entradas de un grupo. 0 = nada que mostrar. */
export function groupPendingTotal(
  entries: readonly Pick<NavEntry, 'pendingKey'>[],
  counts: Partial<Record<PendingCounterKey, number>> | undefined,
): number {
  let total = 0;
  for (const e of entries) {
    const n = e.pendingKey ? counts?.[e.pendingKey] : undefined;
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

/** Un grupo se pliega sólo si tiene más de un ítem accesible. */
export function isGroupCollapsible(visibleEntryCount: number): boolean {
  return visibleEntryCount > 1;
}
