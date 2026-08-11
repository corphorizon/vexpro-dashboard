'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { DEFAULT_ACTIVE_MODULES } from '@/lib/modules';
import { CompanyForm, type CompanyFormValues } from '../_form';

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin/companies/new — create a new tenant
//
// POSTs to /api/superadmin/companies. On success, redirects back to the
// dashboard so the new row appears in the list.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_VALUES: CompanyFormValues = {
  name: '',
  logo_url: '',
  logo_url_white: '',
  logo_icon_url: '',
  color_primary: '#1E3A5F',
  color_secondary: '#3B82F6',
  // El default vive en src/lib/modules.ts y es EL MISMO que aplica el
  // endpoint de alta. Antes eran dos literales gemelos y a los dos les
  // faltaban users/logs/reports/clients.
  active_modules: [...DEFAULT_ACTIVE_MODULES],
  status: 'active',
  reserve_pct: 0.1,
  business_model: 'broker',
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
      const res = await apiFetch('/api/superadmin/companies', {
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
