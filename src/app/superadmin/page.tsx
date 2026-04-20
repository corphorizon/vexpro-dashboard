'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Users, Building2, ArrowRight, Settings, PowerOff } from 'lucide-react';
import { setActiveCompanyId } from '@/lib/active-company';

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
// Plus header actions: "Nueva entidad" and a link to "Usuarios".
// ─────────────────────────────────────────────────────────────────────────────

export default function SuperadminHome() {
  const router = useRouter();
  const [companies, setCompanies] = useState<CompanyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/superadmin/companies');
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

  const enterCompany = (id: string) => {
    setActiveCompanyId(id);
    router.push('/');
  };

  const totalUsers = (companies ?? []).reduce((sum, c) => sum + c.user_count, 0);
  const activeCount = (companies ?? []).filter((c) => c.status === 'active').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Entidades</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gestiona las empresas clientes de la plataforma.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/superadmin/users"
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
          >
            <Users className="w-4 h-4" /> Usuarios
          </Link>
          <Link
            href="/superadmin/companies/new"
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
          >
            <Plus className="w-4 h-4" /> Nueva entidad
          </Link>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <MetricCard
          icon={Building2}
          label="Entidades activas"
          value={activeCount}
          sub={`${companies?.length ?? 0} total`}
        />
        <MetricCard icon={Users} label="Usuarios totales" value={totalUsers} />
        <MetricCard
          icon={PowerOff}
          label="Inactivas"
          value={(companies?.length ?? 0) - activeCount}
          tone="muted"
        />
      </div>

      {/* Error / Loading / Empty */}
      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/50 dark:border-red-800 text-red-800 dark:text-red-200 p-3 text-sm">
          {error}
        </div>
      )}
      {!error && companies === null && (
        <div className="animate-pulse space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 rounded-xl bg-muted/50" />
          ))}
        </div>
      )}
      {!error && companies !== null && companies.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Aún no hay entidades. Crea la primera con "Nueva entidad".
        </div>
      )}

      {/* Table */}
      {companies && companies.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-muted-foreground">
                <th className="text-left p-3 font-medium">Entidad</th>
                <th className="text-left p-3 font-medium hidden sm:table-cell">Slug</th>
                <th className="text-left p-3 font-medium">Usuarios</th>
                <th className="text-left p-3 font-medium">Estado</th>
                <th className="text-right p-3 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} className="border-t border-border hover:bg-muted/30">
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-9 h-9 rounded-md flex items-center justify-center shrink-0 text-white font-semibold text-xs"
                        style={{ backgroundColor: c.color_primary || '#1E3A5F' }}
                      >
                        {c.logo_url ? (
                          // Logos from tenants are arbitrary URLs — use plain
                          // <img> so we don't force the Next.js loader's
                          // domain allowlist.
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.logo_url} alt={c.name} className="w-full h-full object-cover rounded-md" />
                        ) : (
                          initials(c.name)
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium truncate">{c.name}</div>
                        <div className="text-xs text-muted-foreground">
                          Creada: {new Date(c.created_at).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="p-3 hidden sm:table-cell">
                    <code className="text-xs text-muted-foreground">{c.slug}</code>
                  </td>
                  <td className="p-3">{c.user_count}</td>
                  <td className="p-3">
                    <span
                      className={
                        c.status === 'active'
                          ? 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300'
                          : 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                      }
                    >
                      {c.status === 'active' ? 'Activa' : 'Inactiva'}
                    </span>
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end gap-2">
                      <Link
                        href={`/superadmin/companies/${c.id}`}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-border text-xs hover:bg-muted"
                      >
                        <Settings className="w-3 h-3" /> Gestionar
                      </Link>
                      <button
                        onClick={() => enterCompany(c.id)}
                        disabled={c.status !== 'active'}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[var(--color-primary)] text-white text-xs hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Entrar <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'primary',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  sub?: string;
  tone?: 'primary' | 'muted';
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex items-start justify-between">
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={`text-2xl font-bold mt-1 ${tone === 'muted' ? 'text-muted-foreground' : ''}`}>
          {value}
        </p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </div>
      <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-800">
        <Icon className="w-5 h-5 text-slate-600 dark:text-slate-300" />
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}
