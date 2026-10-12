'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/sidebar';
import { Topbar } from '@/components/topbar';
import { TruncatedDataBanner } from '@/components/truncated-data-banner';
import { ViewingAsBanner } from '@/components/viewing-as-banner';
import { ModuleRouteGuard } from '@/components/module-route-guard';
import { ErrorBoundary } from '@/components/error-boundary';
import { PeriodProvider } from '@/lib/period-context';
import { DataProvider } from '@/lib/data-context';
import { DataFreshnessProvider } from '@/lib/data-freshness';
import { useAuth } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { isDev2faBypassEnabled } from '@/lib/auth/dev-2fa-bypass';

// ─────────────────────────────────────────────────────────────────────────────
// Shell del dashboard «Libro mayor» (docs/diseno-libro-mayor.md §6, Fase 4
// 2026-10-12): sidebar que sigue el tema + topbar sticky + contenido de
// 1360 px máx.
//
// Antes: `MobileTopBar` fija (siempre slate-900) sólo en < 1024 px y nada
// arriba en escritorio; contenido `max-w-7xl` (1280) con padding 16/24/32.
// Ahora una sola topbar para todos los anchos; el corte del drawer pasa a
// 960 px (spec §6.3) y el padding es 24 24 64 (16 16 48 en < 640).
//
// La topbar y el banner «Viendo como» comparten UN contenedor sticky: los
// dos eran `sticky top-0` y se pisaban.
// ─────────────────────────────────────────────────────────────────────────────

const SIDEBAR_COLLAPSED_KEY = 'fd_sidebar_collapsed';
const SIDEBAR_ID = 'app-sidebar';

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

  // Si la ventana crece por encima del corte con el drawer abierto, el drawer
  // deja de existir: cerrarlo, o al volver a achicar aparecería abierto y con
  // el foco atrapado.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 960px)');
    const onChange = () => { if (mq.matches) setMobileMenuOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
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

  const closeMobileMenu = useCallback(() => setMobileMenuOpen(false), []);
  const toggleMobileMenu = useCallback(() => setMobileMenuOpen(prev => !prev), []);

  return (
    <div className="flex h-full">
      <Sidebar
        id={SIDEBAR_ID}
        mobileOpen={mobileMenuOpen}
        onClose={closeMobileMenu}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebarCollapsed}
      />
      {/* `relative` NO es decorativo: sin él, cualquier hijo con
          position:absolute (los inputs de archivo `sr-only`, que están en 9
          pantallas) toma al <body> como contenedor de bloque, ESCAPA del
          overflow de este main y estira el documento. El síntoma era una
          segunda barra de scroll: al bajar, el shell entero subía y dejaba
          cientos de píxeles en blanco bajo la barra lateral. */}
      <main className="relative flex-1 min-w-0 overflow-auto">
        <div className="sticky top-[env(safe-area-inset-top,0px)] z-30">
          <Topbar
            onMenuToggle={toggleMobileMenu}
            menuOpen={mobileMenuOpen}
            sidebarId={SIDEBAR_ID}
          />
          <ViewingAsBanner />
        </div>
        {/* Un total corto y creíble es peor que un error: si /api/bootstrap
            recortó algún slice por su techo de filas, hay que decirlo donde
            sea que se mire el número (§1.2). */}
        <TruncatedDataBanner />
        <div className="mx-auto w-full max-w-[1360px] px-4 pt-4 pb-12 sm:px-6 sm:pt-6 sm:pb-16">
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
        <DataFreshnessProvider>
          <DashboardContent>{children}</DashboardContent>
        </DataFreshnessProvider>
      </PeriodProvider>
    </DataProvider>
  );
}
