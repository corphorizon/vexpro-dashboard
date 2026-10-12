'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { actionButtonClass } from '@/components/payment-orders/action-button';
import { DEFAULT_ACTIVE_MODULES } from '@/lib/modules';
// El default del alta sale del registro, no de un literal: cuando se agregó un
// tercer modelo este archivo era el único lugar donde 'broker' estaba escrito a
// mano fuera de business-model.ts.
import { DEFAULT_BUSINESS_MODEL } from '@/lib/business-model';
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
  business_model: DEFAULT_BUSINESS_MODEL,
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
    <div className="max-w-4xl space-y-4">
      <Link href="/superadmin" className={actionButtonClass('ghost', '-ml-3')}>
        <ArrowLeft aria-hidden className="size-4" /> Volver al panel
      </Link>
      <PageHeader title="Nueva entidad" subtitle="Creá una empresa cliente con su branding y sus módulos." />

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
