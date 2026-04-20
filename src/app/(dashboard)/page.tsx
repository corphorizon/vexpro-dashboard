'use client';

import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { getAccessibleGroups } from '@/lib/module-groups';
import { AdminHome } from './_home/admin-home';
import { TeamMemberHome } from './_home/team-member-home';

// ─────────────────────────────────────────────────────────────────────────────
// Home (adaptive dashboard dispatcher)
//
// Routing priority:
//   1. superadmin (bounced to /superadmin by the layout when no active
//      company; when they are viewing a tenant, they see AdminHome).
//   2. admin → AdminHome (full panel, same regardless of module mix).
//   3. Non-admin roles get redirected to the canonical home of their
//      accessible group, using this order when they have several:
//        a. Finanzas   → /resumen-general
//        b. RRHH       → /rrhh/dashboard
//        c. Risk       → /risk/dashboard
//   4. If none of those apply, fall through to TeamMemberHome (shortcuts-
//      only view) — e.g. for "invitado" or for users with only /usuarios
//      or /auditoria.
//
// The actual landing redirect happens inside a useEffect so the user
// briefly sees a skeleton instead of a flash of wrong content.
// ─────────────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const { user, isLoading } = useAuth();
  const { company } = useData();
  const router = useRouter();

  const groups = useMemo(
    () => getAccessibleGroups(user, company?.active_modules),
    [user, company?.active_modules],
  );

  // Resolve the target page for non-admin roles. Null means "render AdminHome
  // or TeamMemberHome inline" (no redirect).
  const redirectTarget = useMemo(() => {
    if (!user || isLoading) return null;
    if (user.is_superadmin) return null; // stays on AdminHome for the tenant
    if (user.effective_role === 'admin') return null;

    // Prefer in this order regardless of how many groups are accessible.
    const order: Array<'finance' | 'hr' | 'risk'> = ['finance', 'hr', 'risk'];
    for (const key of order) {
      const g = groups.find((grp) => grp.key === key);
      if (g) return g.homeHref;
    }
    return null;
  }, [user, isLoading, groups]);

  useEffect(() => {
    if (redirectTarget) router.replace(redirectTarget);
  }, [redirectTarget, router]);

  if (isLoading || !user) return <Skeleton />;

  // Admin / superadmin (viewing a company): full panel.
  if (user.is_superadmin || user.effective_role === 'admin') {
    return <AdminHome />;
  }

  // Non-admin with a known group target: show skeleton while redirecting.
  if (redirectTarget) return <Skeleton />;

  // Fallback: users with only config/audit/etc. modules.
  return <TeamMemberHome />;
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-8 w-48 bg-muted rounded" />
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-28 rounded-xl bg-muted/60" />
        ))}
      </div>
      <div className="h-48 rounded-xl bg-muted/60" />
    </div>
  );
}
