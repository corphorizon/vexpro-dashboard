'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { CompanyForm, type CompanyFormValues } from '../_form';

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin/companies/[id] — edit existing tenant
//
// Loads the row via the Supabase client (RLS permits superadmin), then pushes
// updates to /api/superadmin/companies/:id via PATCH.
// ─────────────────────────────────────────────────────────────────────────────

const supabase = createClient();

export default function EditCompanyPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [values, setValues] = useState<CompanyFormValues | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    (async () => {
      const { data, error } = await supabase
        .from('companies')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) {
        setLoadErr(error.message);
        return;
      }
      if (!data) {
        setLoadErr('Entidad no encontrada');
        return;
      }
      setValues({
        name: data.name || '',
        slug: data.slug,
        logo_url: data.logo_url || '',
        color_primary: data.color_primary || '#1E3A5F',
        color_secondary: data.color_secondary || '#3B82F6',
        active_modules: data.active_modules || [],
        status: (data.status as 'active' | 'inactive') || 'active',
        reserve_pct: data.reserve_pct ?? 0.1,
        currency: data.currency || 'USD',
      });
    })();
  }, [id]);

  const handleSubmit = async (next: CompanyFormValues) => {
    if (!id) return;
    setSubmitting(true);
    setError(null);
    try {
      const { slug: _ignoreSlug, ...payload } = next; // slug is read-only here
      void _ignoreSlug;
      const res = await fetch(`/api/superadmin/companies/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      router.push('/superadmin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando');
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
        <h1 className="text-2xl font-bold">Editar entidad</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Modifica branding, módulos y estado.
        </p>
      </div>

      {loadErr && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800 text-red-800 dark:text-red-200 p-3 text-sm">
          {loadErr}
        </div>
      )}

      {!loadErr && values === null && (
        <div className="animate-pulse h-48 rounded-lg bg-muted/50" />
      )}

      {values !== null && (
        <CompanyForm
          mode="edit"
          initial={values}
          submitting={submitting}
          error={error}
          onSubmit={handleSubmit}
          onCancel={() => router.push('/superadmin')}
        />
      )}
    </div>
  );
}
