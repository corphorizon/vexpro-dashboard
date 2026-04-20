'use client';

import { useAuth } from '@/lib/auth-context';
import { AdminHome } from './_home/admin-home';
import { StaffHome } from './_home/staff-home';
import { TeamMemberHome } from './_home/team-member-home';

// ─────────────────────────────────────────────────────────────────────────────
// Home (adaptive dashboard)
//
// Routes by the authenticated user's effective_role / is_superadmin.
// Superadmin without an active company is bounced to /superadmin by the
// dashboard layout — so when they reach here they ARE viewing a tenant and
// should see the AdminHome (their privileges inside a company = admin).
//
//  · superadmin / admin / auditor → AdminHome (full panel)
//  · socio / hr / supervisor       → StaffHome  (slim KPI + activity)
//  · invitado / team-member        → TeamMemberHome (only shortcuts)
//
// The legacy HR dashboard moved to /rrhh/dashboard.
// ─────────────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const { user, isLoading } = useAuth();

  if (isLoading || !user) {
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

  const role = user.effective_role;
  if (user.is_superadmin || role === 'admin' || role === 'auditor') {
    return <AdminHome />;
  }
  if (role === 'invitado') {
    return <TeamMemberHome />;
  }
  // socio, hr, soporte, plus any custom role that resolves to a non-admin tier.
  return <StaffHome />;
}
