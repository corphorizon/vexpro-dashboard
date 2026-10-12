'use client';

import { usePathname } from 'next/navigation';
import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { ALWAYS_ALLOWED, resolveModule } from '@/lib/route-modules';

// ─────────────────────────────────────────────────────────────────────────────
// ModuleRouteGuard
//
// Central gatekeeper that turns inactive / forbidden modules into a visible
// 403 surface at the layout level. Pages that already have their own guard
// can keep it — this component is a safety net for ones that don't.
//
// Mapping here is explicit (not auto-inferred) so we never accidentally lock
// users out of a route when a new page is added without a registered module.
// The table lives in src/lib/route-modules.ts (pure, testable): the nav
// registry test checks it agrees with every menu entry.
// ─────────────────────────────────────────────────────────────────────────────

export function ModuleRouteGuard({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user } = useAuth();
  const { company } = useData();

  // Personal routes + home pass through.
  if (ALWAYS_ALLOWED.test(pathname)) return <>{children}</>;

  const moduleKey = resolveModule(pathname);
  if (!moduleKey) return <>{children}</>; // unmapped route — let it render

  // Superadmin bypass is baked into hasModuleAccess. For normal users this
  // enforces both user.allowed_modules AND company.active_modules.
  if (hasModuleAccess(user, moduleKey, company?.active_modules, company?.business_model)) {
    return <>{children}</>;
  }

  return (
    <div className="flex items-center justify-center min-h-[40vh]">
      <div className="text-center space-y-2">
        <p className="text-4xl font-bold text-muted-foreground">403</p>
        <p className="text-sm text-muted-foreground">
          Este módulo está desactivado para tu empresa o no tienes permiso para acceder.
        </p>
      </div>
    </div>
  );
}
