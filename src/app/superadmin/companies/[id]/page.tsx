'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Users } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { CompanyForm, type CompanyFormValues } from '../_form';
import { ApiCredentialsPanel } from '@/components/settings/api-credentials-panel';
import { CompanyAuditPanel } from '@/components/settings/company-audit-panel';
import { PageHeader } from '@/components/ui/page-header';
import { Segmented } from '@/components/ui/segmented';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import { actionButtonClass } from '@/components/ui/action-button';

type Tab = 'settings' | 'apis' | 'audit';
const TABS: readonly Tab[] = ['settings', 'apis', 'audit'];

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin/companies/[id] — edit existing tenant
//
// Loads the row via the Supabase client (RLS permits superadmin), then pushes
// updates to /api/superadmin/companies/:id via PATCH.
//
// «Libro mayor» (2026-10-12): pestañas a mano con `border-[var(--color-primary)]`
// y `dark:text-accent` → Segmented; avisos con paleta cruda → Notice; «Usuarios»
// pasa a botón (no es una pestaña: navega a otra pantalla). `?tab=audit` ahora
// abre Auditoría: el enlace «Ver historial completo» del panel de un usuario
// lo pedía y la pantalla lo ignoraba. Carga y PATCH sin cambios.
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
  // Aviso NO bloqueante devuelto por el PATCH (p.ej. cambio de modelo de
  // negocio que deja datos ya cargados fuera de la distribución).
  const [warning, setWarning] = useState<string | null>(null);
  // Three tabs: Configuración (branding + modules), APIs externas, Auditoría.
  // Auditoría lives here (not in the tenant sidebar) because platform audit
  // is a superadmin-only surface.
  const [activeTab, setActiveTab] = useState<Tab>('settings');

  // Pestaña inicial desde `?tab=` (sin useSearchParams: obligaría a envolver
  // la página en Suspense sólo por esto).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && (TABS as readonly string[]).includes(t)) setActiveTab(t as Tab);
  }, []);

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
        logo_url_white: data.logo_url_white || '',
        logo_icon_url: data.logo_icon_url || '',
        color_primary: data.color_primary || '#1E3A5F',
        color_secondary: data.color_secondary || '#3B82F6',
        active_modules: data.active_modules || [],
        status: (data.status as 'active' | 'inactive') || 'active',
        reserve_pct: data.reserve_pct ?? 0.1,
        business_model: data.business_model ?? 'broker',
        currency: data.currency || 'USD',
      });
    })();
  }, [id]);

  const handleSubmit = async (next: CompanyFormValues) => {
    if (!id) return;
    setSubmitting(true);
    setError(null);
    setWarning(null);
    try {
      const { slug: _ignoreSlug, ...payload } = next; // slug is read-only here
      void _ignoreSlug;
      const res = await apiFetch(`/api/superadmin/companies/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      // El cambio de modelo de negocio puede dejar datos fuera de la cadena
      // (depósitos/retiros/prop firm). Si el backend avisa, NO redirigimos:
      // esa advertencia se pierde si la pantalla se va sola al panel.
      if (typeof json.warning === 'string' && json.warning) {
        setValues(next);
        setWarning(json.warning);
        return;
      }
      router.push('/superadmin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-5xl space-y-4">
      <Link href="/superadmin" className={actionButtonClass('ghost', '-ml-3')}>
        <ArrowLeft aria-hidden className="size-4" /> Volver al panel
      </Link>
      <PageHeader
        title={values?.name ? `Editar entidad — ${values.name}` : 'Editar entidad'}
        subtitle="Branding, módulos, estado y credenciales de APIs."
        actions={
          <Link href={`/superadmin/companies/${id}/users`} className={actionButtonClass('secondary')}>
            <Users aria-hidden className="size-4" /> Usuarios
          </Link>
        }
      />

      <Segmented<Tab>
        aria-label="Sección de la entidad"
        value={activeTab}
        onChange={setActiveTab}
        options={[
          { value: 'settings', label: 'Configuración' },
          { value: 'apis', label: 'APIs externas' },
          { value: 'audit', label: 'Auditoría' },
        ]}
      />

      {loadErr && (
        <Notice kind="bad" title="No se pudo cargar la entidad">
          {loadErr}. La configuración no se muestra para no editar sobre datos que no cargaron.
        </Notice>
      )}

      {warning && (
        <Notice
          kind="pend"
          title="Cambios guardados, con una advertencia"
          action={
            <button
              type="button"
              onClick={() => router.push('/superadmin')}
              className="font-medium text-foreground underline underline-offset-2"
            >
              Entendido, volver al panel
            </button>
          }
        >
          {warning}
        </Notice>
      )}

      {activeTab === 'settings' && !loadErr && values === null && <Skeleton className="h-48" />}

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
