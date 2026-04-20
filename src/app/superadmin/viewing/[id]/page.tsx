'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { setActiveCompanyId } from '@/lib/active-company';
import { Loader2 } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin/viewing/[id] — shim that lets a superadmin "enter" a tenant.
//
// The URL deliberately lives under /superadmin so the path itself tells the
// operator they're inside a supervised session. On mount we:
//   1. Persist the chosen company_id (localStorage via setActiveCompanyId).
//   2. Redirect to `/` (the adaptive home). The data-context picks up the
//      activeCompanyId and loads that tenant's data.
//   3. ViewingAsBanner renders globally on every dashboard page so the
//      operator sees "Viendo como Admin: <company>" with a Salir button.
//
// There is no UI here beyond a brief spinner; the screen is transient.
// ─────────────────────────────────────────────────────────────────────────────

export default function SuperadminViewingEnterPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();

  useEffect(() => {
    if (!id) return;
    setActiveCompanyId(id);
    // Use replace so Back doesn't leave the user stuck on this shim.
    router.replace('/');
  }, [id, router]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center">
      <div className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Entrando a la empresa…
      </div>
    </div>
  );
}
