'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Building2, ArrowRight, Settings, RotateCw } from 'lucide-react';
import { formatDate } from '@/lib/dates';
import { PageHeader } from '@/components/ui/page-header';
import { KpiStrip } from '@/components/ui/kpi-strip';
import { Panel } from '@/components/ui/panel';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionButton, actionButtonClass } from '@/components/ui/action-button';
import {
  companyStatusKind,
  companySummary,
  formatCount,
  initials,
  plural,
} from '@/components/superadmin/superadmin-model';

interface CompanyRow {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  color_primary: string | null;
  color_secondary: string | null;
  active_modules: string[];
  status: 'active' | 'inactive';
  created_at: string;
  user_count: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin — Platform dashboard
//
// Lists every tenant with logo, name, status, user count, and two actions:
//   · "Entrar" — sets localStorage.activeCompanyId and redirects to /.
//       The ViewingAsBanner handles the in-entity UX from there.
//   · "Gestionar" — sends the superadmin to the entity detail page
//       (/superadmin/companies/:id) for editing.
//
// «Libro mayor» (2026-10-12):
//   · Tres MetricCard con ícono de color → KpiStrip. Antes, con la carga
//     fallida o en vuelo, mostraban «0 activas · 0 usuarios · 0 inactivas»
//     (sumaban `companies ?? []`): ahora «—» con el motivo
//     (`companySummary(null)` → null, superadmin-model.ts).
//   · «Usuarios totales» es una suma ENTRE empresas: el sub dice de cuántas
//     sale. El conteo por empresa lo arma GET /api/superadmin/companies.
//   · DataTable → FinTable (tarjetas < 720 px). Estado con StatusBadge
//     (activa = ok, inactiva = gris); el avatar ya no pinta texto blanco
//     sobre el color de la marca (con marcas claras no se leía): iniciales
//     neutras y el color de la empresa como una raya de 3 px.
//   · Usuarios / Tokens / Liquidez salieron de la cabecera: viven en la barra
//     lateral del panel (SuperadminShell). Un solo primario: «Nueva entidad».
// ─────────────────────────────────────────────────────────────────────────────

export default function SuperadminHome() {
  const router = useRouter();
  const [companies, setCompanies] = useState<CompanyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/superadmin/companies');
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setCompanies(json.companies);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando entidades');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // "Enter as admin" routes through the viewing shim so the URL reflects
  // that we're inside a supervised session (/superadmin/viewing/<id>).
  const enterAsAdmin = (id: string) => {
    router.push(`/superadmin/viewing/${id}`);
  };

  // Con error NO se usan datos viejos para los KPIs: «—», nunca un número
  // que ya no se sabe si es cierto.
  const summary = error ? null : companySummary(companies);
  const loading = !error && companies === null;
  const reason = error ? 'No se pudo leer la lista' : loading ? 'Cargando…' : undefined;

  const columns: FinColumn<CompanyRow>[] = [
    {
      key: 'name',
      header: 'Entidad',
      cell: (c) => (
        <div className="flex min-w-0 items-center gap-3 py-1.5 max-[720px]:py-0">
          <div
            className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-ui-md border border-border bg-surface-2 text-[12px] font-semibold text-text-2"
            // El color de la marca es un dato de la empresa, no un token:
            // va como raya inferior, sin texto encima.
            style={c.color_primary ? { boxShadow: `inset 0 -3px 0 0 ${c.color_primary}` } : undefined}
          >
            {c.logo_url ? (
              // Logos from tenants are arbitrary URLs — use plain
              // <img> so we don't force the Next.js loader's
              // domain allowlist.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={c.logo_url} alt="" className="size-full object-cover" />
            ) : (
              <span aria-hidden="true">{initials(c.name)}</span>
            )}
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{c.name}</div>
            <div className="truncate text-[12px] leading-[1.3] text-text-3">Creada: {formatDate(c.created_at)}</div>
            <div className="mt-1 hidden flex-wrap items-center gap-1.5 max-[720px]:flex">
              <StatusBadge kind={companyStatusKind(c.status)} label={c.status === 'active' ? 'Activa' : 'Inactiva'} />
              <span className="text-[12px] text-text-3">
                {formatCount(c.user_count)} {plural(c.user_count, 'usuario', 'usuarios')}
              </span>
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'slug',
      header: 'Slug',
      hideSm: true,
      cell: (c) => <code className="font-mono text-[12px] text-text-2">{c.slug}</code>,
    },
    {
      key: 'users',
      header: 'Usuarios',
      kind: 'number',
      hideSm: true,
      value: (c) => c.user_count,
    },
    {
      key: 'status',
      header: 'Estado',
      hideSm: true,
      cell: (c) => <StatusBadge kind={companyStatusKind(c.status)} label={c.status === 'active' ? 'Activa' : 'Inactiva'} />,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Entidades"
        subtitle="Las empresas clientes de la plataforma: branding, módulos, usuarios y credenciales."
        actions={
          <Link href="/superadmin/companies/new" className={actionButtonClass('primary')}>
            <Plus aria-hidden className="size-4" /> Nueva entidad
          </Link>
        }
      />

      <KpiStrip
        items={[
          {
            key: 'active',
            label: 'Entidades activas',
            value: summary?.active,
            format: 'count',
            hero: true,
            sub: summary ? `de ${formatCount(summary.total)} en total` : reason,
            missingBadge: loading ? false : undefined,
          },
          {
            key: 'users',
            label: 'Usuarios totales',
            value: summary?.users,
            format: 'count',
            sub: summary
              ? summary.users === null
                ? `${summary.usersMissing} ${plural(summary.usersMissing, 'entidad', 'entidades')} sin conteo`
                : `suma de ${formatCount(summary.total)} ${plural(summary.total, 'entidad', 'entidades')}`
              : reason,
            missingBadge: loading ? false : undefined,
          },
          {
            key: 'inactive',
            label: 'Inactivas',
            value: summary?.inactive,
            format: 'count',
            sub: summary ? 'sus usuarios no pueden entrar' : reason,
            missingBadge: loading ? false : undefined,
          },
        ]}
      />

      {error && (
        <Notice
          kind="bad"
          title="No se pudo cargar la lista de entidades"
          action={
            <ActionButton variant="secondary" onClick={() => void load()}>
              <RotateCw aria-hidden className="size-4" /> Reintentar
            </ActionButton>
          }
        >
          {error}. Los números de arriba quedan en «—» hasta que la lista cargue.
        </Notice>
      )}

      {/* System alerts — surfaces inactive tenants so the operator notices at
          a glance. Non-blocking and always dismissable by the status change. */}
      {summary && summary.inactive > 0 && (
        <Notice
          kind="pend"
          title={`${summary.inactive} ${plural(summary.inactive, 'empresa inactiva', 'empresas inactivas')}`}
        >
          Los usuarios de entidades inactivas no pueden iniciar sesión. Revisá el estado en la tabla de abajo.
        </Notice>
      )}

      {loading && (
        <Panel title="Todas las entidades" flush>
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        </Panel>
      )}

      {!error && companies !== null && (
        <Panel
          title="Todas las entidades"
          hint={`${formatCount(companies.length)} ${plural(companies.length, 'entidad', 'entidades')}`}
          flush
        >
          <FinTable<CompanyRow>
            caption="Entidades de la plataforma"
            columns={columns}
            rows={companies}
            rowKey={(c) => c.id}
            empty={
              <EmptyState
                compact
                icon={Building2}
                title="Aún no hay entidades"
                description="Creá la primera con «Nueva entidad»."
              />
            }
            rowActions={(c) => (
              <>
                <Link href={`/superadmin/companies/${c.id}`} className={actionButtonClass('ghost')}>
                  <Settings aria-hidden className="size-4" />
                  <span className="max-sm:sr-only">Gestionar</span>
                </Link>
                <ActionButton
                  variant="secondary"
                  onClick={() => enterAsAdmin(c.id)}
                  disabled={c.status !== 'active'}
                  title={c.status !== 'active' ? 'La entidad está inactiva' : undefined}
                >
                  <span className="max-sm:sr-only">Entrar como admin</span>
                  <ArrowRight aria-hidden className="size-4" />
                </ActionButton>
              </>
            )}
          />
        </Panel>
      )}
    </div>
  );
}
