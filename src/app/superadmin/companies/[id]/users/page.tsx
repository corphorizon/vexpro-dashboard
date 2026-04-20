'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Users, Settings2, Loader2 } from 'lucide-react';
import { ManageUserPanel } from './_manage-panel';

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin/companies/[id]/users
//
// Roster of a single tenant — fed by GET /api/superadmin/companies/:id/users.
// Each row opens the slide-over <ManageUserPanel /> where the superadmin can
// change role, status, module access, reset password, disable 2FA, and see
// the user's recent audit activity.
// ─────────────────────────────────────────────────────────────────────────────

export interface CompanyUser {
  id: string;
  user_id: string;
  company_id: string;
  email: string;
  name: string;
  role: string;
  status: 'active' | 'inactive';
  allowed_modules: string[] | null;
  twofa_enabled: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Company {
  id: string;
  name: string;
  active_modules: string[];
}

const ROLE_COLORS: Record<string, string> = {
  admin: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200',
  socio: 'bg-purple-100 text-purple-800 dark:bg-purple-950/50 dark:text-purple-200',
  auditor: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200',
  soporte: 'bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200',
  hr: 'bg-pink-100 text-pink-800 dark:bg-pink-950/50 dark:text-pink-200',
  invitado: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200',
};

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  socio: 'Socio',
  auditor: 'Auditor',
  soporte: 'Soporte',
  hr: 'HR',
  invitado: 'Invitado',
};

export default function CompanyUsersPage() {
  const params = useParams<{ id: string }>();
  const companyId = params?.id;

  const [users, setUsers] = useState<CompanyUser[]>([]);
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CompanyUser | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/superadmin/companies/${companyId}/users`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setUsers(json.users);
      setCompany(json.company);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando usuarios');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleUpdated = (updated: CompanyUser) => {
    setUsers((prev) => prev.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)));
    setSelected((curr) => (curr && curr.id === updated.id ? { ...curr, ...updated } : curr));
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between gap-4">
        <Link
          href={`/superadmin/companies/${companyId}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" /> Volver a la entidad
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Users className="w-6 h-6" /> Usuarios {company?.name ? `— ${company.name}` : ''}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Gestiona roles, accesos por módulo, seguridad y auditoría de cada usuario de la organización.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800 text-red-800 dark:text-red-200 p-3 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando usuarios…
        </div>
      ) : users.length === 0 ? (
        <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
          Esta organización aún no tiene usuarios.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Usuario</th>
                <th className="text-left px-4 py-2.5 font-medium">Rol</th>
                <th className="text-left px-4 py-2.5 font-medium">Estado</th>
                <th className="text-left px-4 py-2.5 font-medium">2FA</th>
                <th className="text-left px-4 py-2.5 font-medium">Último acceso</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-border hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-[var(--color-primary)] text-white flex items-center justify-center text-xs font-semibold shrink-0">
                        {initials(u.name || u.email)}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium truncate">{u.name || '(sin nombre)'}</div>
                        <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        ROLE_COLORS[u.role] ?? ROLE_COLORS.invitado
                      }`}
                    >
                      {ROLE_LABEL[u.role] ?? u.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1.5 text-xs ${
                        u.status === 'active'
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-muted-foreground'
                      }`}
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          u.status === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground/50'
                        }`}
                      />
                      {u.status === 'active' ? 'Activo' : 'Inactivo'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {u.twofa_enabled ? (
                      <span className="text-emerald-700 dark:text-emerald-400">Activo</span>
                    ) : (
                      <span className="text-muted-foreground">No configurado</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatLastLogin(u.last_login_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setSelected(u)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border hover:bg-muted"
                    >
                      <Settings2 className="w-3.5 h-3.5" /> Gestionar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && company && (
        <ManageUserPanel
          user={selected}
          companyActiveModules={company.active_modules}
          onClose={() => setSelected(null)}
          onUpdated={handleUpdated}
        />
      )}
    </div>
  );
}

function initials(label: string): string {
  return (label || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

function formatLastLogin(ts: string | null): string {
  if (!ts) return 'Nunca';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const now = Date.now();
  const diffMs = now - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'hace un momento';
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `hace ${days} d`;
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
}
