'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ShieldCheck, ArrowLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useData } from '@/lib/data-context';
import { clearActiveCompanyId } from '@/lib/active-company';

// ─────────────────────────────────────────────────────────────────────────────
// ViewingAsBanner
//
// Only renders when the authenticated user is a SUPERADMIN and has navigated
// into a specific company via the /superadmin panel. Keeps the context
// painfully obvious so the superadmin never confuses data of one tenant with
// another.
//
// Clicking "Volver al panel" clears the active-company pointer and bounces
// back to /superadmin.
// ─────────────────────────────────────────────────────────────────────────────

export function ViewingAsBanner() {
  const { user } = useAuth();
  const { company } = useData();
  const router = useRouter();

  // Render nothing for normal users or when the superadmin hasn't entered a
  // company yet.
  if (!user?.is_superadmin) return null;
  if (!company) return null;

  const handleExit = () => {
    clearActiveCompanyId();
    router.push('/superadmin');
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-40 flex items-center justify-between gap-3 px-4 py-2 text-sm font-medium border-b border-amber-300/80 bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-100 dark:border-amber-800"
    >
      <div className="flex items-center gap-2 min-w-0">
        <ShieldCheck className="w-4 h-4 shrink-0" />
        <span className="truncate">
          Viendo como superadmin · <strong className="font-semibold">{company.name}</strong>
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Link
          href="/superadmin"
          className="hidden sm:inline text-xs underline hover:no-underline"
        >
          Panel superadmin
        </Link>
        <button
          onClick={handleExit}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-200/80 hover:bg-amber-200 dark:bg-amber-900 dark:hover:bg-amber-800 text-amber-900 dark:text-amber-100 text-xs"
        >
          <ArrowLeft className="w-3 h-3" />
          Volver al panel
        </button>
      </div>
    </div>
  );
}
