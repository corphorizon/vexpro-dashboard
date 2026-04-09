'use client';

import { Toaster } from 'sonner';
import { AuthProvider } from '@/lib/auth-context';
import { ThemeProvider, useTheme } from '@/lib/theme-context';
import { I18nProvider } from '@/lib/i18n';

function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      position="bottom-right"
      theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      richColors
      closeButton
      duration={2500}
    />
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          {children}
          <ThemedToaster />
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
