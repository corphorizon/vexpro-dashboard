'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
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
          <Link href="/superadmin" className="flex items-center gap-2 font-semibold">
            <ShieldCheck className="w-5 h-5 text-amber-300" />
            Horizon Consulting · Panel
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
