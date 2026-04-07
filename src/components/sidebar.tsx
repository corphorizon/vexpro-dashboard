'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAuth, hasModuleAccess, ROLE_LABELS } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useTheme } from '@/lib/theme-context';
import { useI18n } from '@/lib/i18n';
import {
  LayoutDashboard,
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
  // Dashboard (standalone)
  { type: 'link', href: '/', i18nKey: 'nav.dashboard', icon: LayoutDashboard, module: 'summary' },

  // Finanzas (collapsible)
  {
    type: 'section',
    i18nKey: 'nav.finance',
    icon: DollarSign,
    children: [
      { href: '/movimientos', i18nKey: 'nav.movements', icon: ArrowLeftRight, module: 'movements' },
      { href: '/egresos', i18nKey: 'nav.expenses', icon: Receipt, module: 'expenses' },
      { href: '/liquidez', i18nKey: 'nav.liquidity', icon: Droplets, module: 'liquidity' },
      { href: '/inversiones', i18nKey: 'nav.investments', icon: TrendingUp, module: 'investments' },
      { href: '/socios', i18nKey: 'nav.partners', icon: UsersIcon, module: 'partners' },
      { href: '/upload', i18nKey: 'nav.upload', icon: Upload, module: 'upload' },
      { href: '/periodos', i18nKey: 'nav.periods', icon: CalendarDays, module: 'periods' },
    ],
  },

  // Recursos Humanos (standalone)
  { type: 'link', href: '/rrhh', i18nKey: 'nav.hr', icon: UserCog, module: 'hr' },

  // Configuraciones (collapsible)
  {
    type: 'section',
    i18nKey: 'nav.settings',
    icon: Settings,
    children: [
      { href: '/usuarios', i18nKey: 'nav.users', icon: UsersIcon, module: 'users' },
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
    // Close mobile menu on navigation
    onClose?.();
  };

  const renderLink = (item: NavLink, indent = false) => {
    if (!hasModuleAccess(user, item.module)) return null;
    const isActive = pathname === item.href;
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={handleNavClick}
        className={cn(
          'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
          indent && 'ml-4',
          isActive
            ? 'bg-[var(--color-primary)] text-white'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
      >
        <Icon className="w-4 h-4" />
        {t(item.i18nKey)}
      </Link>
    );
  };

  return (
    <>
      {/* Backdrop for mobile */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={cn(
          'w-64 border-r border-border bg-card flex flex-col min-h-screen',
          // Desktop: always visible, static
          'hidden lg:flex',
          // Mobile: fixed overlay drawer
          mobileOpen && '!flex fixed inset-y-0 left-0 z-50 shadow-2xl'
        )}
      >
        {/* Logo */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-center">
            <Image
              src="/vex-logofull.png"
              alt={company?.name || 'Company'}
              width={180}
              height={50}
              className="object-contain block dark:hidden"
              priority
            />
            <Image
              src="/vex-logofull-white.png"
              alt={company?.name || 'Company'}
              width={180}
              height={50}
              className="object-contain hidden dark:block"
              priority
            />
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
          {NAV_STRUCTURE.map((entry) => {
            if (entry.type === 'link') {
              return renderLink(entry as NavLink);
            }

            // Section (collapsible)
            const section = entry as NavSection;
            const visibleChildren = section.children.filter(c => hasModuleAccess(user, c.module));
            if (visibleChildren.length === 0) return null;

            const isOpen = openSections[section.i18nKey] ?? false;
            const hasActiveChild = visibleChildren.some(c => pathname === c.href || pathname.startsWith(c.href + '/'));
            const SectionIcon = section.icon;

            return (
              <div key={section.i18nKey}>
                <button
                  onClick={() => toggleSection(section.i18nKey)}
                  className={cn(
                    'flex items-center justify-between w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    hasActiveChild
                      ? 'text-[var(--color-primary)]'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  )}
                >
                  <span className="flex items-center gap-3">
                    <SectionIcon className="w-4 h-4" />
                    {t(section.i18nKey)}
                  </span>
                  <ChevronDown
                    className={cn(
                      'w-4 h-4 transition-transform duration-200',
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
        <div className="p-4 border-t border-border space-y-3">
          {/* Theme & Language toggles */}
          <div className="flex items-center justify-center gap-1">
            <button
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              {resolvedTheme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              {resolvedTheme === 'dark' ? 'Light' : 'Dark'}
            </button>
            <span className="text-muted-foreground/30">|</span>
            <button
              onClick={() => setLocale(locale === 'es' ? 'en' : 'es')}
              aria-label="Change language"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              <Globe className="w-3.5 h-3.5" />
              {locale === 'es' ? 'EN' : 'ES'}
            </button>
          </div>

          {user && (
            <div className="text-xs text-muted-foreground text-center">
              {user.name} ({ROLE_LABELS[user.role] || user.role})
            </div>
          )}
          <Link
            href="/perfil"
            onClick={handleNavClick}
            className={cn(
              'flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium transition-colors',
              pathname === '/perfil'
                ? 'bg-[var(--color-primary)] text-white'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            <UserCircle className="w-4 h-4" />
            {t('nav.profile')}
          </Link>
          <button
            onClick={handleLogout}
            aria-label={t('nav.logout')}
            className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            <LogOut className="w-4 h-4" />
            {t('nav.logout')}
          </button>
        </div>
      </aside>
    </>
  );
}
