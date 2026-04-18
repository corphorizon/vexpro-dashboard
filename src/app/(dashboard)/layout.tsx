'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { Sidebar } from '@/components/sidebar';
import { ErrorBoundary } from '@/components/error-boundary';
import { PeriodProvider } from '@/lib/period-context';
import { DataProvider } from '@/lib/data-context';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { useTheme } from '@/lib/theme-context';
import { useI18n } from '@/lib/i18n';
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
          <Link href="/">
            <Image
              src="/vex-logofull-white.png"
              alt={company?.name || 'Company'}
              width={100}
              height={28}
              className="object-contain"
            />
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

function DashboardContent({ children }: { children: React.ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="flex h-full">
      <MobileTopBar onMenuToggle={() => setMobileMenuOpen(prev => !prev)} />
      <Sidebar mobileOpen={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} />
      <main className="flex-1 overflow-auto pt-14 lg:pt-0">
        <div className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
          <ErrorBoundary>
            {children}
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
  const { t } = useI18n();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    // Force password change takes priority over 2FA setup.
    if (user.must_change_password) {
      router.replace('/perfil?forceChangePassword=1');
      return;
    }
    // Force 2FA setup on first login (unless user has already set it up).
    if (user.force_2fa_setup && !user.twofa_enabled) {
      router.replace('/setup-2fa');
      return;
    }
  }, [user, isLoading, router]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">{t('common.loading')}</div>
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
