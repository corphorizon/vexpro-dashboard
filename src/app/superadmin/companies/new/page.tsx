'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { CompanyForm, ALL_MODULES, type CompanyFormValues } from '../_form';

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin/companies/new — create a new tenant
//
// POSTs to /api/superadmin/companies. On success, redirects back to the
// dashboard so the new row appears in the list.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_VALUES: CompanyFormValues = {
  name: '',
  logo_url: '',
  color_primary: '#1E3A5F',
  color_secondary: '#3B82F6',
  // Reasonable default module set for a fresh tenant.
  active_modules: ALL_MODULES.map((m) => m.key).filter((k) =>
    ['summary', 'movements', 'expenses', 'liquidity', 'investments', 'balances', 'partners', 'upload', 'periods'].includes(k),
  ),
  status: 'active',
  reserve_pct: 0.1,
  currency: 'USD',
};

export default function NewCompanyPage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (values: CompanyFormValues) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/superadmin/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      router.push('/superadmin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error creando entidad');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <Link
        href="/superadmin"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" /> Volver al panel
      </Link>
      <div>
        <h1 className="text-2xl font-bold">Nueva entidad</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Crea una empresa cliente con su branding y módulos.
        </p>
      </div>

      <CompanyForm
        mode="create"
        initial={DEFAULT_VALUES}
        submitting={submitting}
        error={error}
        onSubmit={handleSubmit}
        onCancel={() => router.push('/superadmin')}
      />
    </div>
  );
}
