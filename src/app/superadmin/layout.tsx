'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { isDev2faBypassEnabled } from '@/lib/auth/dev-2fa-bypass';
import { ShieldCheck, LogOut } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin — Horizon Consulting platform panel.
//
// Layout guard: only users with `is_superadmin = true` can render anything
// under this route. Everyone else (unauthenticated OR authenticated but not
// superadmin) gets bounced out.
//
// This is the first Phase-3 surface — a minimal shell with the guard and a
// landing page. The full dashboard + entity CRUD + user CRUD come in Phase 4.
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
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">Cargando…</p>
      </div>
    );
  }

  if (!user || !user.is_superadmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-muted-foreground text-sm">403 · Acceso restringido</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-slate-900 text-slate-100">
        <div className="max-w-7xl mx-auto flex items-center justify-between px-4 py-3">
          <Link href="/superadmin" className="flex items-center gap-3 font-semibold">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/brand/logo-white.svg"
              alt="Smart Dashboard"
              className="h-7 w-auto object-contain"
            />
            <span className="hidden sm:inline text-slate-300 font-normal">·</span>
            <ShieldCheck className="w-4 h-4 text-amber-300" />
            <span className="text-sm">Superadmin</span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <span className="hidden sm:inline text-slate-400">{user.email}</span>
            <button
              onClick={logout}
              className="inline-flex items-center gap-1 text-slate-300 hover:text-white"
            >
              <LogOut className="w-4 h-4" /> Salir
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
