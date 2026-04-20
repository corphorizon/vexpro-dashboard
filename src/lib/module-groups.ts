import { hasModuleAccess, type User } from '@/lib/auth-context';

// ─────────────────────────────────────────────────────────────────────────────
// Module groups — same structure the sidebar renders, expressed as pure data
// so dispatcher + sidebar share the same source of truth.
//
// "Group count" drives two decisions:
//   · Dispatcher: when a non-admin user has exactly ONE accessible group,
//     we redirect them to that group's canonical home (Resumen General for
//     Finanzas, Dashboard RRHH for HR, Dashboard Risk for Risk).
//   · Sidebar: same condition flattens the menu — no collapsibles, direct
//     links to that group's items, with the group name as the header.
// ─────────────────────────────────────────────────────────────────────────────

export type ModuleGroupKey = 'finance' | 'hr' | 'risk' | 'config';

export interface ModuleGroupItem {
  module: string;
  href: string;
  labelEs: string;
}

export interface ModuleGroup {
  key: ModuleGroupKey;
  /** Canonical landing page for this group (used by the dispatcher). */
  homeHref: string;
  /** Spanish label — kept co-located here so sidebar + dashboard share it. */
  labelEs: string;
  items: ModuleGroupItem[];
}

export const MODULE_GROUPS: ModuleGroup[] = [
  {
    key: 'finance',
    labelEs: 'Finanzas',
    homeHref: '/resumen-general',
    items: [
      { module: 'summary',     href: '/resumen-general', labelEs: 'Resumen General' },
      { module: 'movements',   href: '/movimientos',     labelEs: 'Movimientos' },
      { module: 'expenses',    href: '/egresos',         labelEs: 'Egresos' },
      { module: 'liquidity',   href: '/liquidez',        labelEs: 'Liquidez' },
      { module: 'investments', href: '/inversiones',     labelEs: 'Inversiones' },
      { module: 'balances',    href: '/balances',        labelEs: 'Balances' },
      { module: 'partners',    href: '/socios',          labelEs: 'Socios' },
      { module: 'upload',      href: '/upload',          labelEs: 'Carga de Datos' },
      { module: 'periods',     href: '/periodos',        labelEs: 'Períodos' },
    ],
  },
  {
    key: 'hr',
    labelEs: 'Recursos Humanos',
    homeHref: '/rrhh/dashboard',
    items: [
      { module: 'hr',          href: '/rrhh/dashboard',  labelEs: 'Dashboard RRHH' },
      { module: 'hr',          href: '/rrhh',            labelEs: 'Empleados' },
      { module: 'commissions', href: '/comisiones',      labelEs: 'Comisiones' },
    ],
  },
  {
    key: 'risk',
    labelEs: 'Risk Management',
    homeHref: '/risk/dashboard',
    items: [
      { module: 'risk',        href: '/risk/dashboard',       labelEs: 'Dashboard Risk' },
      { module: 'risk',        href: '/risk/retiros-propfirm', labelEs: 'Retiros PropFirm' },
      { module: 'risk',        href: '/risk/retiros-wallet',   labelEs: 'Retiros Wallet' },
    ],
  },
  {
    // Kept as a "group" so single-module users (e.g. HR-only → /usuarios)
    // still get the flat sidebar treatment. Only Usuarios remains — the
    // Configuraciones umbrella disappeared with the dissolved settings
    // module, and Audit moved to the superadmin panel.
    key: 'config',
    labelEs: 'Usuarios',
    homeHref: '/usuarios',
    items: [
      { module: 'users', href: '/usuarios', labelEs: 'Usuarios' },
    ],
  },
];

/**
 * Returns the groups the user can access given their membership and the
 * tenant's active_modules. Each group is included only if at least one of
 * its items passes both user-level and tenant-level checks.
 */
export function getAccessibleGroups(
  user: User | null,
  activeModules: string[] | null | undefined,
): ModuleGroup[] {
  if (!user) return [];
  return MODULE_GROUPS.filter((g) =>
    g.items.some((item) => hasModuleAccess(user, item.module, activeModules)),
  );
}

/**
 * Filters a group's items down to what the user can see. Useful for the
 * flattened sidebar — we only render accessible entries even within the
 * single visible group.
 */
export function getAccessibleItems(
  user: User | null,
  group: ModuleGroup,
  activeModules: string[] | null | undefined,
): ModuleGroupItem[] {
  if (!user) return [];
  return group.items.filter((item) => hasModuleAccess(user, item.module, activeModules));
}
