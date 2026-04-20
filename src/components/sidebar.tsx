'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAuth, hasModuleAccess, ROLE_LABELS } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { CompanyLogo } from '@/components/company-logo';
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
  FileSearch,
  Briefcase,
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
  // Dashboard — HR summary
  { type: 'link', href: '/', i18nKey: 'nav.dashboard', icon: LayoutDashboard, module: 'summary' },

  // Finanzas (collapsible)
  {
    type: 'section',
    i18nKey: 'nav.finance',
    icon: DollarSign,
    children: [
      { href: '/resumen-general', i18nKey: 'nav.generalSummary', icon: BarChart3, module: 'summary' },
      { href: '/movimientos', i18nKey: 'nav.movements', icon: ArrowLeftRight, module: 'movements' },
      { href: '/egresos', i18nKey: 'nav.expenses', icon: Receipt, module: 'expenses' },
      { href: '/liquidez', i18nKey: 'nav.liquidity', icon: Droplets, module: 'liquidity' },
      { href: '/inversiones', i18nKey: 'nav.investments', icon: TrendingUp, module: 'investments' },
      { href: '/balances', i18nKey: 'nav.balances', icon: Wallet, module: 'balances' },
      { href: '/socios', i18nKey: 'nav.partners', icon: Briefcase, module: 'partners' },
      { href: '/upload', i18nKey: 'nav.upload', icon: Upload, module: 'upload' },
      { href: '/periodos', i18nKey: 'nav.periods', icon: CalendarDays, module: 'periods' },
    ],
  },

  // Recursos Humanos (collapsible)
  {
    type: 'section',
    i18nKey: 'nav.hr',
    icon: UserCog,
    children: [
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
      { href: '/risk/retiros-propfirm', i18nKey: 'nav.riskWithdrawals', icon: FileSearch, module: 'risk' },
      { href: '/risk/retiros-wallet', i18nKey: 'nav.riskWalletWithdrawals', icon: Wallet, module: 'risk' },
    ],
  },

  // Configuraciones (collapsible)
  {
    type: 'section',
    i18nKey: 'nav.settings',
    icon: Settings,
    children: [
      { href: '/usuarios', i18nKey: 'nav.users', icon: UsersIcon, module: 'users' },
      { href: '/configuraciones', i18nKey: 'nav.config', icon: Settings, module: 'settings' },
      { href: '/auditoria', i18nKey: 'nav.audit', icon: ClipboardList, module: 'audit' },
    ],
  },
];

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ mobileOpen = false, onClose }: SidebarProps) {
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

  const renderLink = (item: NavLink, indent = false) => {
    // Sidebar respects BOTH the user's allowed_modules AND the tenant's
    // active_modules — a deactivated module never shows, even to admins.
    // Superadmins bypass (handled inside hasModuleAccess).
    if (!hasModuleAccess(user, item.module, company?.active_modules)) return null;
    const isActive = pathname === item.href;
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={handleNavClick}
        className={cn(
          'group flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all',
          indent && 'ml-3 pl-3 border-l border-slate-700/60',
          isActive
            ? 'bg-[var(--color-primary)] text-white shadow-sm'
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
          'w-64 flex flex-col min-h-screen bg-slate-900 border-r border-slate-800 text-slate-200',
          'hidden lg:flex',
          mobileOpen && '!flex fixed inset-y-0 left-0 z-50 shadow-2xl'
        )}
      >
        {/* Logo — tenant-branded. Uses company.logo_url when present,
            otherwise renders initials on the company's primary color. */}
        <div className="p-5 border-b border-slate-800">
          <Link href="/" onClick={handleNavClick} className="flex items-center gap-3 justify-center">
            <CompanyLogo
              name={company?.name || 'Horizon'}
              logoUrl={company?.logo_url}
              colorPrimary={company?.color_primary}
              className="w-10 h-10"
              initialsClassName="text-sm"
            />
            <span className="text-white font-semibold text-sm truncate max-w-[140px]">
              {company?.name || 'Dashboard'}
            </span>
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto custom-scrollbar">
          {NAV_STRUCTURE.map((entry) => {
            if (entry.type === 'link') {
              return renderLink(entry as NavLink);
            }

            const section = entry as NavSection;
            const visibleChildren = section.children.filter(c =>
              hasModuleAccess(user, c.module, company?.active_modules),
            );
            if (visibleChildren.length === 0) return null;

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
                    <SectionIcon className={cn(
                      'w-4 h-4 shrink-0',
                      hasActiveChild ? 'text-[var(--color-primary)]' : ''
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
          })}
        </nav>

        {/* Footer */}
        <div className="p-3 border-t border-slate-800 space-y-2">
          {/* User info */}
          {user && (
            <div className="px-3 pb-2 text-center">
              <p className="text-xs font-medium text-slate-200 truncate">{user.name}</p>
              <p className="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">
                {ROLE_LABELS[user.role] || user.role}
              </p>
            </div>
          )}

          {/* Profile + Logout */}
          <Link
            href="/perfil"
            onClick={handleNavClick}
            className={cn(
              'group flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all',
              pathname === '/perfil'
                ? 'bg-[var(--color-primary)] text-white'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            )}
          >
            <UserCircle className="w-4 h-4 text-slate-400 group-hover:text-white transition-colors" />
            <span>{t('nav.profile')}</span>
          </Link>
          <button
            onClick={handleLogout}
            aria-label={t('nav.logout')}
            className="group flex items-center gap-3 w-full px-3 py-2 rounded-lg text-sm font-medium text-slate-300 hover:bg-red-900/30 hover:text-red-200 transition-all"
          >
            <LogOut className="w-4 h-4 text-slate-400 group-hover:text-red-200 transition-colors" />
            <span>{t('nav.logout')}</span>
          </button>

          {/* Theme + Language toggles */}
          <div className="flex items-center justify-center gap-1 pt-2 mt-2 border-t border-slate-800">
            <button
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-slate-400 hover:bg-slate-800 hover:text-white transition-all"
            >
              {resolvedTheme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              {resolvedTheme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <span className="text-slate-700">|</span>
            <button
              onClick={() => setLocale(locale === 'es' ? 'en' : 'es')}
              aria-label="Change language"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-slate-400 hover:bg-slate-800 hover:text-white transition-all"
            >
              <Globe className="w-3.5 h-3.5" />
              {locale === 'es' ? 'EN' : 'ES'}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
