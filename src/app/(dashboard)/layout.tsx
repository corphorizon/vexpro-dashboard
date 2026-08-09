'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Sidebar } from '@/components/sidebar';
import { CompanyLogo } from '@/components/company-logo';
import { ViewingAsBanner } from '@/components/viewing-as-banner';
import { ModuleRouteGuard } from '@/components/module-route-guard';
import { ErrorBoundary } from '@/components/error-boundary';
import { PeriodProvider } from '@/lib/period-context';
import { DataProvider } from '@/lib/data-context';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useTheme } from '@/lib/theme-context';
import { useI18n } from '@/lib/i18n';
import { isDev2faBypassEnabled } from '@/lib/auth/dev-2fa-bypass';
import { Menu, Globe, Sun, Moon, UserCircle } from 'lucide-react';

function MobileTopBar({ onMenuToggle }: { onMenuToggle: () => void }) {
  const { user } = useAuth();
  const { company } = useData();
  const { resolvedTheme, setTheme } = useTheme();
  const { locale, setLocale } = useI18n();

  return (
    <header className="lg:hidden fixed top-0 left-0 right-0 z-30 bg-slate-900 border-b border-slate-800 text-slate-200 shadow-sm">
      <div className="flex items-center justify-between px-4 h-14">
        {/* Left: hamburger + logo */}
        <div className="flex items-center gap-3">
          <button
            onClick={onMenuToggle}
            className="p-2 -ml-2 rounded-lg text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
            aria-label="Toggle menu"
          >
            <Menu className="w-5 h-5" />
          </button>
          <Link href="/" className="flex items-center gap-2">
            <CompanyLogo
              name={company?.name || 'Horizon'}
              logoUrl={company?.logo_url}
              colorPrimary={company?.color_primary}
              className="w-7 h-7"
              initialsClassName="text-[10px]"
            />
            <span className="font-semibold text-sm truncate max-w-[140px]">
              {company?.name || 'Dashboard'}
            </span>
          </Link>
        </div>

        {/* Right: utilities */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setLocale(locale === 'es' ? 'en' : 'es')}
            className="p-2 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
            aria-label="Change language"
          >
            <Globe className="w-5 h-5" />
          </button>
          <button
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            className="p-2 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
            aria-label="Toggle theme"
          >
            {resolvedTheme === 'dark' ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
          <Link
            href="/perfil"
            className="p-2 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
            aria-label="Profile"
          >
            <UserCircle className="w-5 h-5" />
          </Link>
        </div>
      </div>
    </header>
  );
}

const SIDEBAR_COLLAPSED_KEY = 'fd_sidebar_collapsed';

function DashboardContent({ children }: { children: React.ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // El estado del rail vive acá (no en el Sidebar) para que <main> siga el
  // ancho. Arranca SIEMPRE expandido y adopta lo guardado en un effect —
  // leer localStorage durante el primer render rompería la hidratación
  // (mismo patrón que theme-context y el seed de idioma de abajo).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    try {
      setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
    } catch { /* SSR/privacidad: sin localStorage se queda expandido */ }
  }, []);

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      } catch { /* no persistimos, pero la sesión actual sí cambia */ }
      return next;
    });
  }, []);

  return (
    <div className="flex h-full">
      <MobileTopBar onMenuToggle={() => setMobileMenuOpen(prev => !prev)} />
      <Sidebar
        mobileOpen={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapsed}
      />
      {/* `relative` NO es decorativo: sin él, cualquier hijo con
          position:absolute (los inputs de archivo `sr-only`, que están en 9
          pantallas) toma al <body> como contenedor de bloque, ESCAPA del
          overflow de este main y estira el documento. El síntoma era una
          segunda barra de scroll: al bajar, el shell entero subía y dejaba
          cientos de píxeles en blanco bajo la barra lateral. */}
      <main className="relative flex-1 min-w-0 overflow-auto pt-14 lg:pt-0 transition-[width,padding] duration-200">
        <ViewingAsBanner />
        <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
          <ErrorBoundary>
            <ModuleRouteGuard>{children}</ModuleRouteGuard>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const { t, setLocale } = useI18n();

  // Seed del idioma desde la preferencia guardada en DB (fase 7): si el
  // usuario nunca tocó el toggle en ESTE navegador (sin fd_locale en
  // localStorage), adoptamos su preferred_language — usuarios nuevos ven
  // inglés (default de la columna), los existentes español (backfill 052).
  useEffect(() => {
    if (!user?.preferred_language) return;
    try {
      if (!localStorage.getItem('fd_locale')) setLocale(user.preferred_language);
    } catch { /* SSR/privacidad: sin localStorage no hay seed */ }
  }, [user?.preferred_language, setLocale]);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    // Superadmins live in /superadmin; if they land on any dashboard route
    // without first choosing a company via the "Viewing as" flow, bounce them
    // to the platform panel. (Once they enter an entity, activeCompanyId is
    // set and the data-context loads that company's data — they stay here.)
    if (user.is_superadmin) {
      // Using a dynamic import rather than a static one to avoid pulling
      // localStorage access into this file's top-level. The helper itself
      // already guards against SSR.
      import('@/lib/active-company').then(({ getActiveCompanyId }) => {
        if (!getActiveCompanyId()) {
          router.replace('/superadmin');
        }
      });
      return;
    }
    // Force password change takes priority over 2FA setup.
    if (user.must_change_password) {
      router.replace('/perfil?forceChangePassword=1');
      return;
    }
    // Force 2FA setup on first login (unless user has already set it up).
    // Bypass: when running on localhost with NEXT_PUBLIC_DEV_SKIP_2FA=true,
    // skip the redirect so dev iterations don't need a real authenticator.
    if (user.force_2fa_setup && !user.twofa_enabled && !isDev2faBypassEnabled()) {
      router.replace('/setup-2fa');
      return;
    }
  }, [user, isLoading, router]);

  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/logo-black.svg"
          alt="Smart Dashboard"
          className="h-20 w-auto object-contain animate-pulse block dark:hidden"
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/logo-white.svg"
          alt="Smart Dashboard"
          className="h-20 w-auto object-contain animate-pulse hidden dark:block"
        />
        <div className="text-muted-foreground text-sm">{t('common.loading')}</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">{t('setup2fa.redirecting')}</div>
      </div>
    );
  }

  return (
    <DataProvider>
      <PeriodProvider>
        <DashboardContent>{children}</DashboardContent>
      </PeriodProvider>
    </DataProvider>
  );
}
