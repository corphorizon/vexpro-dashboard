'use client';

import { useAuth, hasModuleAccess } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';

// ─────────────────────────────────────────────────────────────────────────────
// useModuleAccess
//
// React-friendly wrapper around `hasModuleAccess` that pulls both the
// current user and the current company's active_modules list from context.
//
// Use from any client component that needs to decide whether to render a
// module page. SUPERADMINs always pass.
//
// Example:
//   const canView = useModuleAccess('balances');
//   if (!canView) return <NoAccess />;
// ─────────────────────────────────────────────────────────────────────────────

export function useModuleAccess(module: string): boolean {
  const { user } = useAuth();
  const { company } = useData();
  return hasModuleAccess(user, module, company?.active_modules);
}
