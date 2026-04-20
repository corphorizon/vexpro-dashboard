'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Settings as SettingsIcon, Key, ClipboardList, Users } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { CompanyForm, type CompanyFormValues } from '../_form';
import { ApiCredentialsPanel } from '@/components/settings/api-credentials-panel';
import { CompanyAuditPanel } from '@/components/settings/company-audit-panel';

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
  // Three tabs: Configuración (branding + modules), APIs externas, Auditoría.
  // Auditoría lives here (not in the tenant sidebar) because platform audit
  // is a superadmin-only surface.
  const [activeTab, setActiveTab] = useState<'settings' | 'apis' | 'audit'>('settings');

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
        <h1 className="text-2xl font-bold">
          Editar entidad{values?.name ? ` — ${values.name}` : ''}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Modifica branding, módulos, estado y credenciales de APIs.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border overflow-x-auto">
        <button
          onClick={() => setActiveTab('settings')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'settings'
              ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <SettingsIcon className="w-4 h-4" /> Configuración
        </button>
        <button
          onClick={() => setActiveTab('apis')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'apis'
              ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Key className="w-4 h-4" /> APIs externas
        </button>
        <button
          onClick={() => setActiveTab('audit')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'audit'
              ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <ClipboardList className="w-4 h-4" /> Auditoría
        </button>
        <Link
          href={`/superadmin/companies/${id}/users`}
          className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground transition-colors"
        >
          <Users className="w-4 h-4" /> Usuarios
        </Link>
      </div>

      {loadErr && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800 text-red-800 dark:text-red-200 p-3 text-sm">
          {loadErr}
        </div>
      )}

      {!loadErr && values === null && (
        <div className="animate-pulse h-48 rounded-lg bg-muted/50" />
      )}

      {activeTab === 'apis' && id && (
        <ApiCredentialsPanel companyId={id} />
      )}

      {activeTab === 'audit' && id && (
        <CompanyAuditPanel companyId={id} />
      )}

      {activeTab === 'settings' && values !== null && (
        <CompanyForm
          mode="edit"
          companyId={id}
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
