'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api-fetch';
import { useAuth, hasModuleAccess, ROLE_LABELS } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { getAccessibleGroups, getAccessibleItems } from '@/lib/module-groups';
import { useTheme } from '@/lib/theme-context';
import { useI18n } from '@/lib/i18n';
import {
  LayoutDashboard,
  BarChart3,
  ArrowLeftRight,
  Receipt,
  Droplets,
  TrendingUp,
  Users as UsersIcon,
  Upload,
  Settings,
  LogOut,
  CalendarDays,
  UserCog,
  ClipboardList,
  Sun,
  Moon,
  UserCircle,
  Globe,
  ChevronDown,
  DollarSign,
  Wallet,
  Calculator,
  ShieldCheck,
  ShieldAlert,
  Activity,
  FileSearch,
  Briefcase,
  FileText,
  FileSignature,
  Table,
  Circle,
  ChevronLeft,
  ChevronRight,
  ScrollText,
  Contact,
  Database,
  Sparkles,
  Landmark,
} from 'lucide-react';

// ─── Types ───

interface NavLink {
  href: string;
  i18nKey: string;
  icon: React.ComponentType<{ className?: string }>;
  module: string;
}

interface NavSection {
  type: 'section';
  i18nKey: string;
  icon: React.ComponentType<{ className?: string }>;
  children: NavLink[];
}

interface NavItem {
  type: 'link';
  href: string;
  i18nKey: string;
  icon: React.ComponentType<{ className?: string }>;
  module: string;
}

type NavEntry = NavItem | NavSection;

const NAV_STRUCTURE: NavEntry[] = [
  // Home — adaptive dashboard (different view per role; see src/app/(dashboard)/page.tsx)
  { type: 'link', href: '/', i18nKey: 'nav.home', icon: LayoutDashboard, module: 'summary' },

  // Finanzas (collapsible)
  {
    type: 'section',
    i18nKey: 'nav.finance',
    icon: DollarSign,
    children: [
      { href: '/resumen-general', i18nKey: 'nav.generalSummary', icon: BarChart3, module: 'summary' },
      { href: '/movimientos', i18nKey: 'nav.movements', icon: ArrowLeftRight, module: 'movements' },
      { href: '/egresos', i18nKey: 'nav.expenses', icon: Receipt, module: 'expenses' },
      // Consulta de ingresos operativos — el espejo de Egresos; la carga sigue
      // viviendo en "Carga de Datos".
      { href: '/ingresos', i18nKey: 'nav.income', icon: TrendingUp, module: 'income' },
      { href: '/liquidez', i18nKey: 'nav.liquidity', icon: Droplets, module: 'liquidity' },
      { href: '/liquidez-pool', i18nKey: 'nav.liquidityPool', icon: Droplets, module: 'liquidity_pool' },
      { href: '/inversiones', i18nKey: 'nav.investments', icon: TrendingUp, module: 'investments' },
      // El producto de inversión que el broker le vende a SUS clientes,
      // espejado del CRM. No confundir con 'investments', que es la cartera
      // propia cargada a mano — ver el comentario de `hedge_fund` en
      // modules.ts. Se ve sólo en el modelo `broker`.
      { href: '/hedge-fund', i18nKey: 'nav.hedgeFund', icon: Landmark, module: 'hedge_fund' },
      { href: '/balances', i18nKey: 'nav.balances', icon: Wallet, module: 'balances' },
      { href: '/socios', i18nKey: 'nav.partners', icon: Briefcase, module: 'partners' },
      { href: '/clientes', i18nKey: 'nav.clients', icon: Contact, module: 'clients' },
      { href: '/ordenes-pago', i18nKey: 'nav.paymentOrders', icon: FileSignature, module: 'payment_orders' },
      { href: '/upload', i18nKey: 'nav.upload', icon: Upload, module: 'upload' },
      { href: '/periodos', i18nKey: 'nav.periods', icon: CalendarDays, module: 'periods' },
      { href: '/finanzas/reportes', i18nKey: 'nav.reports', icon: FileText, module: 'reports' },
      // Kevin 2026-06-06: tabla mes-a-mes con todos los indicadores,
      // columnas y meses ocultables, totales al pie. Misma puerta de
      // módulo que reports (ambos son vistas ejecutivas).
      { href: '/finanzas/consolidado', i18nKey: 'nav.consolidado', icon: Table, module: 'reports' },
      // Forecast (tanda 5 de la auditoría): la única vista forward-looking.
      { href: '/finanzas/forecast', i18nKey: 'nav.forecast', icon: TrendingUp, module: 'reports' },
      // Los totales que ya salen solos del CRM (P2P, ventas y retiros de prop
      // firm), al lado de lo cargado a mano. Puerta 'income': es información
      // de ingresos, y quien la mira es quien carga los ingresos.
      { href: '/finanzas/crm', i18nKey: 'nav.crmTotals', icon: Database, module: 'income' },
    ],
  },

  // Recursos Humanos (collapsible)
  {
    type: 'section',
    i18nKey: 'nav.hr',
    icon: UserCog,
    children: [
      // HR dashboard (formerly the app home) now sits inside the HR group.
      { href: '/rrhh/dashboard', i18nKey: 'nav.hrDashboard', icon: LayoutDashboard, module: 'hr' },
      { href: '/rrhh', i18nKey: 'nav.hrManagement', icon: UsersIcon, module: 'hr' },
      { href: '/comisiones', i18nKey: 'nav.commissions', icon: Calculator, module: 'commissions' },
    ],
  },

  // Risk Management (collapsible)
  {
    type: 'section',
    i18nKey: 'nav.risk',
    icon: ShieldCheck,
    children: [
      // Landing page for risk-only roles (support). Listed first so the
      // flat-menu mode puts it at the top.
      { href: '/risk/dashboard', i18nKey: 'nav.riskDashboard', icon: LayoutDashboard, module: 'risk' },
      { href: '/risk/retiros-propfirm', i18nKey: 'nav.riskWithdrawals', icon: FileSearch, module: 'risk' },
      // La cola de retiros del CRM. Reemplaza al viejo retiros-wallet, que se
      // ELIMINÓ en la auditoría 2026-08-06 (QW10) por ser 100% mock — se
      // reconstruyó desde cero contra el espejo real del CRM (migración 088).
      { href: '/risk/retiros', i18nKey: 'nav.riskWithdrawalQueue', icon: ShieldAlert, module: 'risk' },
      { href: '/risk/exposicion', i18nKey: 'nav.riskExposure', icon: Activity, module: 'risk' },
    ],
  },

  // Usuarios — top-level now that the "Configuraciones" group is gone.
  // Auditoría is no longer in the tenant sidebar; it's only reachable from
  // the superadmin panel (per-company tab).
  { type: 'link', href: '/usuarios', i18nKey: 'nav.users', icon: UsersIcon, module: 'users' },
  // Registro de Actividad — arriba de todo lo que audita, no dentro de un
  // grupo: aplica a los movimientos de TODOS los modulos, no de uno.
  { type: 'link', href: '/logs', i18nKey: 'nav.logs', icon: ScrollText, module: 'logs' },
  // Asistente IA — transversal como el Registro de Actividad: responde de
  // finanzas, RRHH y riesgo a la vez, así que meterlo dentro de un grupo
  // sugeriría un alcance que no tiene.
  { type: 'link', href: '/asistente', i18nKey: 'nav.assistant', icon: Sparkles, module: 'assistant' },
];

// Mapa href → icono, derivado de NAV_STRUCTURE. Lo usa el modo flat (los
// items de module-groups no traen icono) cuando el sidebar está contraído:
// en el rail solo hay iconos, así que cada destino necesita uno.
const ICON_BY_HREF: Record<string, React.ComponentType<{ className?: string }>> = (() => {
  const map: Record<string, React.ComponentType<{ className?: string }>> = {};
  for (const entry of NAV_STRUCTURE) {
    if (entry.type === 'link') {
      map[entry.href] = entry.icon;
    } else {
      for (const child of entry.children) map[child.href] = child.icon;
    }
  }
  return map;
})();

/** Hasta dos iniciales del nombre — avatar del footer en modo contraído. */
function userInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(part => part.charAt(0).toUpperCase())
    .join('') || '?';
}

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
  /** Rail solo-iconos (desktop). El estado vive en el layout. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function Sidebar({ mobileOpen = false, onClose, collapsed = false, onToggleCollapse }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const { company } = useData();
  const { resolvedTheme, setTheme } = useTheme();
  const { locale, setLocale, t } = useI18n();

  // Auto-open sections that contain the active page
  const getInitialOpen = () => {
    const open: Record<string, boolean> = {};
    for (const entry of NAV_STRUCTURE) {
      if (entry.type === 'section') {
        const hasActive = entry.children.some(c => pathname === c.href || pathname.startsWith(c.href + '/'));
        open[entry.i18nKey] = hasActive;
      }
    }
    return open;
  };

  const [openSections, setOpenSections] = useState<Record<string, boolean>>(getInitialOpen);

  // El rail contraído es SOLO desktop: cuando el drawer móvil está abierto
  // mostramos siempre el menú completo (no regresamos el comportamiento móvil).
  const isCollapsed = collapsed && !mobileOpen;
  const collapseLabel = isCollapsed ? t('nav.expand') : t('nav.collapse');

  const toggleSection = (key: string) => {
    setOpenSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  const handleNavClick = () => {
    onClose?.();
  };

  // ── Flat-menu detection ────────────────────────────────────────────────
  // When a non-admin user has access to exactly ONE module group (Finanzas,
  // RRHH, Risk, or Config), render a simplified sidebar: no collapsibles,
  // a group heading at the top, and the group's items listed directly.
  // Admin and superadmin always see the full collapsible structure.
  const accessibleGroups = getAccessibleGroups(user, company?.active_modules, company?.business_model);
  const useFlatMenu =
    user !== null &&
    !user.is_superadmin &&
    user.effective_role !== 'admin' &&
    accessibleGroups.length === 1;
  const flatGroup = useFlatMenu ? accessibleGroups[0] : null;
  const flatItems = flatGroup
    ? getAccessibleItems(user, flatGroup, company?.active_modules, company?.business_model)
    : [];

  const renderLink = (item: NavLink, indent = false) => {
    // Sidebar respects BOTH the user's allowed_modules AND the tenant's
    // active_modules — a deactivated module never shows, even to admins.
    // Superadmins bypass (handled inside hasModuleAccess) — salvo lo que el
    // modelo de negocio de la empresa no contempla, que no se muestra a nadie.
    if (!hasModuleAccess(user, item.module, company?.active_modules, company?.business_model)) return null;
    // Match exacto O prefijo de ruta hija — así /movimientos/desglose/[slug]
    // mantiene iluminado el leaf "Movimientos" (antes solo se iluminaba la
    // sección y el usuario perdía la ubicación). Guard: '/' solo exacto.
    const isActive =
      pathname === item.href ||
      (item.href !== '/' && pathname.startsWith(item.href + '/'));
    const Icon = item.icon;
    const label = t(item.i18nKey);

    // Rail contraído: solo icono, centrado, con `title` nativo como tooltip.
    if (isCollapsed) {
      return (
        <Link
          key={item.href}
          href={item.href}
          onClick={handleNavClick}
          title={label}
          aria-label={label}
          className={cn(
            'group flex items-center justify-center h-10 rounded-lg transition-all',
            isActive
              ? 'bg-[var(--brand-on-dark-surface)] text-white shadow-sm'
              : 'text-slate-300 hover:bg-slate-800 hover:text-white',
          )}
        >
          <Icon className={cn(
            'w-5 h-5 shrink-0 transition-colors',
            isActive ? 'text-white' : 'text-slate-400 group-hover:text-white',
          )} />
        </Link>
      );
    }

    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={handleNavClick}
        className={cn(
          'group flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all',
          indent && 'ml-3 pl-3 border-l border-slate-700/60',
          isActive
            ? 'bg-[var(--brand-on-dark-surface)] text-white shadow-sm'
            : 'text-slate-300 hover:bg-slate-800 hover:text-white'
        )}
      >
        <Icon className={cn(
          'w-4 h-4 shrink-0 transition-colors',
          isActive ? 'text-white' : 'text-slate-400 group-hover:text-white'
        )} />
        <span className="truncate">{t(item.i18nKey)}</span>
      </Link>
    );
  };

  return (
    <>
      {/* Backdrop for mobile */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      {/*
        Sidebar: always-dark slate palette regardless of theme. Works with
        both the light and dark content areas because the sidebar reads as
        a distinct surface. White logo + slate icons + primary color for
        active states.
      */}
      <aside
        className={cn(
          'flex flex-col min-h-screen bg-slate-900 border-r border-slate-800 text-slate-200',
          'hidden lg:flex transition-[width,padding] duration-200',
          isCollapsed ? 'w-16' : 'w-64',
          mobileOpen && '!flex fixed inset-y-0 left-0 z-50 shadow-2xl'
        )}
      >
        {/* Logo — tenant-branded. Big, centered, no text. When no logo
            is configured we fall back to the company name as typography
            so the header doesn't look broken.
            Prefer logo_url_white (designed for dark backgrounds) and fall
            back to logo_url when the tenant hasn't uploaded a white version.

            Contraído usa el isotipo (logo_icon_url, migración 072): el logo
            ancho metido en 64px se veía como un cuadrado en blanco. */}
        <div className={cn(
          'border-b border-slate-800',
          isCollapsed ? 'px-2 py-4 flex flex-col items-center gap-2' : 'px-4 py-6 flex items-center gap-3',
        )}>
          <Link
            href="/"
            onClick={handleNavClick}
            className={cn(
              'flex items-center min-w-0',
              isCollapsed ? 'justify-center' : 'flex-1 justify-start',
            )}
            aria-label={company?.name || 'Inicio'}
            title={isCollapsed ? (company?.name || 'Inicio') : undefined}
          >
            {isCollapsed ? (
              company?.logo_icon_url ? (
                // Isotipo: sin fondo blanco: el archivo trae su propio fondo
                // (o transparencia) y un cuadrado blanco detrás lo tapaba.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={company.logo_icon_url}
                  alt={company?.name ?? ''}
                  className="w-10 h-10 object-contain"
                  onError={(e) => {
                    const el = e.currentTarget;
                    el.style.display = 'none';
                  }}
                />
              ) : (
                // Sin isotipo se mantiene el comportamiento de siempre: la
                // inicial sobre el primario, con la variante que se ve sobre
                // el slate del sidebar (que es oscuro en los dos temas).
                <span
                  className="w-10 h-10 rounded-lg flex items-center justify-center text-sm font-semibold text-white"
                  style={{ backgroundColor: 'var(--brand-on-dark-surface)' }}
                  aria-hidden="true"
                >
                  {(company?.name || 'D').trim().charAt(0).toUpperCase()}
                </span>
              )
            ) : (company?.logo_url_white || company?.logo_url) ? (
              // Native <img> on purpose — tenant logos come from arbitrary
              // URLs and we don't want to force every domain into the
              // Next.js image allow-list.
              // Alto generoso + ancho completo de la columna: antes el
              // max-w-[180px] achicaba cualquier logo horizontal a ~36px.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={company?.logo_url_white || company?.logo_url || ''}
                alt={company?.name ?? ''}
                className="h-16 w-full object-contain object-left"
                onError={(e) => {
                  // Fail gracefully: swap for name text if the URL 404s.
                  const el = e.currentTarget;
                  el.style.display = 'none';
                  const parent = el.parentElement;
                  if (parent) {
                    parent.innerHTML = `<span class="text-white font-semibold text-lg truncate max-w-[180px]">${(company?.name || 'Dashboard').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))}</span>`;
                  }
                }}
              />
            ) : (
              <span className="text-white font-semibold text-lg truncate max-w-[180px]">
                {company?.name || 'Dashboard'}
              </span>
            )}
          </Link>

          {/* Contraer / expandir — solo desktop (el drawer móvil no lo usa).
              Expandido: a la derecha del logo. Contraído: debajo de la marca
              compacta, centrado, para que quepa en los 64px del rail. */}
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={collapseLabel}
              title={collapseLabel}
              aria-expanded={!isCollapsed}
              className={cn(
                'hidden lg:flex shrink-0 items-center justify-center rounded-lg',
                'text-slate-400 hover:bg-slate-800 hover:text-white transition-all',
                isCollapsed ? 'w-9 h-9' : 'w-7 h-7',
              )}
            >
              {isCollapsed
                ? <ChevronRight className="w-4 h-4" />
                : <ChevronLeft className="w-4 h-4" />}
            </button>
          )}
        </div>

        {/* Flat-menu heading (single-group users) — shows the group name
            above the links so the user knows which area they're in. */}
        {useFlatMenu && flatGroup && !isCollapsed && (
          <div className="px-5 pt-4 pb-2">
            <p className="text-[10px] uppercase tracking-[0.15em] text-slate-400">
              {flatGroup.labelEs}
            </p>
          </div>
        )}

        {/* Navigation */}
        <nav className={cn(
          'flex-1 space-y-1 overflow-y-auto custom-scrollbar',
          isCollapsed ? 'p-2' : 'p-3',
        )}>
          {/* Flat mode: direct list of accessible items, no collapsibles,
              slightly roomier padding for easier clicking. */}
          {useFlatMenu && flatGroup ? (
            flatItems.map((item) => {
              const isActive = pathname === item.href;
              // Contraído: mismos items y mismo orden, solo que como iconos.
              if (isCollapsed) {
                const FlatIcon = ICON_BY_HREF[item.href] ?? Circle;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={handleNavClick}
                    title={item.labelEs}
                    aria-label={item.labelEs}
                    className={cn(
                      'group flex items-center justify-center h-10 rounded-lg transition-all',
                      isActive
                        ? 'bg-[var(--brand-on-dark-surface)] text-white shadow-sm'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                    )}
                  >
                    <FlatIcon className={cn(
                      'w-5 h-5 shrink-0 transition-colors',
                      isActive ? 'text-white' : 'text-slate-400 group-hover:text-white',
                    )} />
                  </Link>
                );
              }
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={handleNavClick}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all',
                    isActive
                      ? 'bg-[var(--brand-on-dark-surface)] text-white shadow-sm'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white',
                  )}
                >
                  <span className="truncate">{item.labelEs}</span>
                </Link>
              );
            })
          ) : (
          NAV_STRUCTURE.map((entry) => {
            if (entry.type === 'link') {
              return renderLink(entry as NavLink);
            }

            const section = entry as NavSection;
            const visibleChildren = section.children.filter(c =>
              hasModuleAccess(user, c.module, company?.active_modules, company?.business_model),
            );
            if (visibleChildren.length === 0) return null;

            // Rail contraído: sin fila de sección (no hay sitio para el label
            // ni el chevron). Aplanamos y mostramos los hijos accesibles como
            // iconos, así todo destino sigue a un clic. Sin fly-out.
            if (isCollapsed) {
              return (
                <div
                  key={section.i18nKey}
                  className="space-y-1 pt-1 mt-1 border-t border-slate-800/70 first:border-t-0 first:mt-0 first:pt-0"
                >
                  {visibleChildren.map(child => renderLink(child))}
                </div>
              );
            }

            const isOpen = openSections[section.i18nKey] ?? false;
            const hasActiveChild = visibleChildren.some(c => pathname === c.href || pathname.startsWith(c.href + '/'));
            const SectionIcon = section.icon;

            return (
              <div key={section.i18nKey} className="pt-0.5">
                <button
                  onClick={() => toggleSection(section.i18nKey)}
                  className={cn(
                    'flex items-center justify-between w-full px-3 py-2 rounded-lg text-sm font-semibold transition-all',
                    hasActiveChild
                      ? 'text-white bg-slate-800/50'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                  )}
                >
                  <span className="flex items-center gap-3">
                    {/* El sidebar es SIEMPRE oscuro (slate-900) en ambos temas:
                        navy acá era invisible — acento claro fijo. */}
                    <SectionIcon className={cn(
                      'w-4 h-4 shrink-0',
                      hasActiveChild ? 'text-[#60A5FA]' : ''
                    )} />
                    <span className="uppercase tracking-wide text-[11px]">{t(section.i18nKey)}</span>
                  </span>
                  <ChevronDown
                    className={cn(
                      'w-3.5 h-3.5 transition-transform duration-200',
                      isOpen && 'rotate-180'
                    )}
                  />
                </button>
                {isOpen && (
                  <div className="mt-1 space-y-0.5">
                    {visibleChildren.map(child => renderLink(child, true))}
                  </div>
                )}
              </div>
            );
          })
          )}
        </nav>

        {/* Footer */}
        <div className={cn('border-t border-slate-800 space-y-2', isCollapsed ? 'p-2' : 'p-3')}>
          {/* User info — contraído: solo las iniciales del usuario. */}
          {user && isCollapsed && (
            <div
              className="mx-auto w-9 h-9 rounded-full bg-slate-800 text-slate-200 flex items-center justify-center text-[11px] font-semibold"
              title={`${user.name} · ${ROLE_LABELS[user.role] || user.role}`}
            >
              {userInitials(user.name)}
            </div>
          )}
          {user && !isCollapsed && (
            <div className="px-3 pb-2 text-center">
              <p className="text-xs font-medium text-slate-200 truncate">{user.name}</p>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">
                {ROLE_LABELS[user.role] || user.role}
              </p>
            </div>
          )}

          {/* Notificaciones — en desktop no hay header, así que la campanita
              vive acá; el panel se abre hacia arriba porque el bloque está
              pegado al pie de la pantalla. */}
          <div className={cn(isCollapsed && 'flex justify-center')}>
            <NotificationBell variant="sidebar" collapsed={isCollapsed} />
          </div>

          {/* Perfil */}
          <Link
            href="/perfil"
            onClick={handleNavClick}
            title={isCollapsed ? t('nav.profile') : undefined}
            aria-label={t('nav.profile')}
            className={cn(
              // Centrado en ambos estados: el resto del footer (avatar,
              // nombre, tema/idioma) ya va centrado y estos dos quedaban
              // pegados a la izquierda, rompiendo el eje del bloque.
              'group flex items-center justify-center rounded-lg text-sm font-medium transition-all',
              isCollapsed ? 'h-10' : 'gap-2 px-3 py-2',
              pathname === '/perfil'
                ? 'bg-[var(--brand-on-dark-surface)] text-white'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            )}
          >
            <UserCircle className={cn(
              'text-slate-400 group-hover:text-white transition-colors',
              isCollapsed ? 'w-5 h-5' : 'w-4 h-4',
            )} />
            {!isCollapsed && <span>{t('nav.profile')}</span>}
          </Link>

          {/* Theme + Language toggles — contraído se apilan en vertical y
              pierden el texto, conservando los aria-label. */}
          <div className={cn(
            'pt-2 mt-2 border-t border-slate-800',
            isCollapsed
              ? 'flex flex-col items-center gap-1'
              : 'flex items-center justify-center gap-1',
          )}>
            <button
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              title={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className={cn(
                'flex items-center rounded-lg text-[11px] font-medium text-slate-400 hover:bg-slate-800 hover:text-white transition-all',
                isCollapsed ? 'justify-center w-9 h-9' : 'gap-1.5 px-2.5 py-1.5',
              )}
            >
              {resolvedTheme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              {!isCollapsed && (resolvedTheme === 'dark' ? 'Light' : 'Dark')}
            </button>
            {!isCollapsed && <span className="text-slate-700">|</span>}
            <button
              onClick={() => {
                const next = locale === 'es' ? 'en' : 'es';
                setLocale(next);
                // Persistir la preferencia para que los EMAILS salgan en el
                // idioma del usuario (fase 7). Fire-and-forget: si falla, el
                // localStorage local sigue mandando en la UI.
                apiFetch('/api/user/language', {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ language: next }),
                }).catch(() => {});
              }}
              aria-label="Change language"
              title="Change language"
              className={cn(
                'flex items-center rounded-lg text-[11px] font-medium text-slate-400 hover:bg-slate-800 hover:text-white transition-all',
                isCollapsed ? 'justify-center w-9 h-9' : 'gap-1.5 px-2.5 py-1.5',
              )}
            >
              <Globe className="w-3.5 h-3.5" />
              {!isCollapsed && (locale === 'es' ? 'EN' : 'ES')}
            </button>
          </div>

          {/* Cerrar sesión — SIEMPRE el último control del sidebar
              (pedido de Kevin: nada debajo). */}
          <div className="pt-2 mt-2 border-t border-slate-800">
            <button
              onClick={handleLogout}
              aria-label={t('nav.logout')}
              title={isCollapsed ? t('nav.logout') : undefined}
              className={cn(
                'group flex items-center justify-center w-full rounded-lg text-sm font-medium text-slate-300 hover:bg-red-900/30 hover:text-red-200 transition-all',
                isCollapsed ? 'h-10' : 'gap-2 px-3 py-2',
              )}
            >
              <LogOut className={cn(
                'text-slate-400 group-hover:text-red-200 transition-colors',
                isCollapsed ? 'w-5 h-5' : 'w-4 h-4',
              )} />
              {!isCollapsed && <span>{t('nav.logout')}</span>}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
