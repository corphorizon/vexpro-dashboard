'use client';

import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { QuickAccess } from './quick-access';

// ─────────────────────────────────────────────────────────────────────────────
// TeamMemberHome — most restricted view.
//
// No financial numbers. No audit feed. Only module shortcuts the member can
// reach. Aimed at roles like `invitado` / external team-members who still
// need dashboard access but shouldn't see company KPIs.
// ─────────────────────────────────────────────────────────────────────────────

export function TeamMemberHome() {
  const { user } = useAuth();
  const { company } = useData();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">Hola, {user?.name?.split(' ')[0] ?? ''}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {company?.name ? `Bienvenido a ${company.name}` : 'Bienvenido'}
        </p>
      </header>

      <QuickAccess heading="Tus accesos" />
    </div>
  );
}
