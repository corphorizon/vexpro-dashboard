'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { isDev2faBypassEnabled } from '@/lib/auth/dev-2fa-bypass';
import { LoadingScreen } from '@/components/loading-screen';
import { SystemScreen } from '@/components/system-screen';
import { SuperadminShell } from '@/components/superadmin/superadmin-shell';
import { actionButtonClass } from '@/components/ui/action-button';

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin — Horizon Consulting platform panel.
//
// Layout guard: only users with `is_superadmin = true` can render anything
// under this route. Everyone else (unauthenticated OR authenticated but not
// superadmin) gets bounced out.
//
// «Libro mayor» (2026-10-12): la cabecera `bg-slate-900` siempre oscura pasó
// a SuperadminShell (components/superadmin/), de la misma familia que el
// shell del dashboard; carga y 403 usan las pantallas de sistema compartidas.
// El guard y sus redirecciones no cambiaron.
// ─────────────────────────────────────────────────────────────────────────────

export default function SuperadminLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading, logout } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace('/login');
      return;
    }
    if (!user.is_superadmin) {
      // Not a superadmin — kick them back to the normal dashboard.
      router.replace('/');
      return;
    }
    // Mandatory 2FA enrolment — applies to superadmins too. Mirror of the
    // gate in (dashboard)/layout.tsx. Migration 029 set force_2fa_setup=true
    // on every platform_users row, so the first time a superadmin lands
    // here after the reset they are redirected to /setup-2fa.
    // Bypass only on localhost when NEXT_PUBLIC_DEV_SKIP_2FA=true.
    if (user.force_2fa_setup && !user.twofa_enabled && !isDev2faBypassEnabled()) {
      router.replace('/setup-2fa');
      return;
    }
  }, [user, isLoading, router]);

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!user || !user.is_superadmin) {
    return (
      <SystemScreen
        code="403"
        title="Acceso restringido"
        body="Este panel es sólo para los superadmins de la plataforma. Te estamos redirigiendo."
        action={
          <Link href="/" className={actionButtonClass('primary')}>
            Ir al inicio
          </Link>
        }
      />
    );
  }

  return (
    <SuperadminShell email={user.email} name={user.name} onLogout={logout}>
      {children}
    </SuperadminShell>
  );
}
