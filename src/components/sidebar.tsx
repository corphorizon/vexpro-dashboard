'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAuth, hasModuleAccess, ROLE_LABELS } from '@/lib/auth-context';
import { DEMO_COMPANY } from '@/lib/demo-data';
import { useTheme } from '@/lib/theme-context';
import { useI18n } from '@/lib/i18n';
import {
  LayoutDashboard,
  ArrowLeftRight,
  Receipt,
  Droplets,
  TrendingUp,
  Users,
  Building2,
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
} from 'lucide-react';

const NAV_ITEMS = [
  { href: '/', i18nKey: 'nav.summary', icon: LayoutDashboard, module: 'summary' },
  { href: '/movimientos', i18nKey: 'nav.movements', icon: ArrowLeftRight, module: 'movements' },
  { href: '/egresos', i18nKey: 'nav.expenses', icon: Receipt, module: 'expenses' },
  { href: '/liquidez', i18nKey: 'nav.liquidity', icon: Droplets, module: 'liquidity' },
  { href: '/inversiones', i18nKey: 'nav.investments', icon: TrendingUp, module: 'investments' },
  { href: '/socios', i18nKey: 'nav.partners', icon: Users, module: 'partners' },
  { href: '/upload', i18nKey: 'nav.upload', icon: Upload, module: 'upload' },
  { href: '/periodos', i18nKey: 'nav.periods', icon: CalendarDays, module: 'periods' },
  { href: '/rrhh', i18nKey: 'nav.hr', icon: UserCog, module: 'hr' },
  { href: '/usuarios', i18nKey: 'nav.users', icon: Settings, module: 'users' },
  { href: '/auditoria', i18nKey: 'nav.audit', icon: ClipboardList, module: 'audit' },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const { locale, setLocale, t } = useI18n();

  const visibleItems = NAV_ITEMS.filter(item => hasModuleAccess(user, item.module));

  const handleLogout = () => {
    logout();
    router.push('/login');
  };

  return (
    <aside className="w-64 border-r border-border bg-card flex flex-col min-h-screen">
      {/* Logo */}
      <div className="p-6 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--color-primary)] flex items-center justify-center">
            <Building2 className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-lg leading-tight">{DEMO_COMPANY.name}</h1>
            <p className="text-xs text-muted-foreground">Smart Dashboard</p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {visibleItems.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <Icon className="w-4 h-4" />
              {t(item.i18nKey)}
            </Link>
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
  );
}
