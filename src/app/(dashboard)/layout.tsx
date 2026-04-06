'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/sidebar';
import { ErrorBoundary } from '@/components/error-boundary';
import { PeriodProvider } from '@/lib/period-context';
import { DataProvider } from '@/lib/data-context';
import { useAuth } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const { t } = useI18n();

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace('/login');
    }
    if (!isLoading && user && !user.twofa_enabled) {
      // Uncomment to force 2FA setup on first login:
      // router.replace('/setup-2fa');
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
        <div className="flex h-full">
          <Sidebar />
          <main className="flex-1 overflow-auto">
            <div className="max-w-7xl mx-auto p-6 lg:p-8">
              <ErrorBoundary>
                {children}
              </ErrorBoundary>
            </div>
          </main>
        </div>
      </PeriodProvider>
    </DataProvider>
  );
}
