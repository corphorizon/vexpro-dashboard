'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Plus, Trash2, Loader2 } from 'lucide-react';
import { ALL_MODULES } from '../companies/_form';

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin/users — cross-tenant user management
//
// Lists every company_users row across the platform with the company name
// joined in. The superadmin can:
//   · Filter by company
//   · Invite a new user to any company (sends a magic link)
//   · Change a user's role (admin/auditor/hr/socio/soporte/invitado)
//   · Remove the membership
//
// Auth user records in auth.users are NOT deleted here — only the membership,
// because the same person may belong to multiple tenants.
// ─────────────────────────────────────────────────────────────────────────────

interface UserRow {
  id: string;
  user_id: string;
  company_id: string;
  email: string;
  name: string;
  role: string;
  allowed_modules: string[] | null;
  twofa_enabled: boolean;
  created_at: string;
  companies: { name: string; slug: string; status: string } | null;
}

interface CompanyOpt {
  id: string;
  name: string;
  slug: string;
  status: string;
}

const ROLES = ['admin', 'auditor', 'hr', 'socio', 'soporte', 'invitado'] as const;

export default function SuperadminUsersPage() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [companies, setCompanies] = useState<CompanyOpt[]>([]);
  const [filterCompany, setFilterCompany] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const qs = filterCompany === 'all' ? '' : `?company_id=${filterCompany}`;
      const [uRes, cRes] = await Promise.all([
        fetch(`/api/superadmin/users${qs}`),
        fetch('/api/superadmin/companies'),
      ]);
      const uJson = await uRes.json();
      const cJson = await cRes.json();
      if (!uJson.success) throw new Error(uJson.error || 'Error cargando usuarios');
      if (!cJson.success) throw new Error(cJson.error || 'Error cargando entidades');
      setUsers(uJson.users);
      setCompanies(cJson.companies);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  }, [filterCompany]);

  useEffect(() => {
    load();
  }, [load]);

  const updateUser = async (id: string, patch: Partial<Pick<UserRow, 'role' | 'name' | 'allowed_modules'>>) => {
    const res = await fetch(`/api/superadmin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      alert(json.error || 'Error actualizando');
      return;
    }
    load();
  };

  const deleteUser = async (id: string, email: string) => {
    if (!confirm(`Eliminar la membresía de ${email}?`)) return;
    const res = await fetch(`/api/superadmin/users/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok || !json.success) {
      alert(json.error || 'Error eliminando');
      return;
    }
    load();
  };

  return (
    <div className="space-y-6">
      <Link
        href="/superadmin"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" /> Volver al panel
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Usuarios</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gestión de usuarios cross-tenant.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={filterCompany}
            onChange={(e) => setFilterCompany(e.target.value)}
            className="h-9 px-3 rounded-lg border border-border bg-card text-sm"
          >
            <option value="all">Todas las entidades</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            onClick={() => setInviteOpen(true)}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
          >
            <Plus className="w-4 h-4" /> Invitar usuario
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800 text-red-800 dark:text-red-200 p-3 text-sm">
          {error}
        </div>
      )}

      {!error && users === null && (
        <div className="animate-pulse h-48 rounded-lg bg-muted/50" />
      )}

      {users !== null && users.length === 0 && !error && (
        <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Sin usuarios para el filtro actual.
        </div>
      )}

      {users && users.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="text-left p-3 font-medium">Usuario</th>
                <th className="text-left p-3 font-medium">Empresa</th>
                <th className="text-left p-3 font-medium">Rol</th>
                <th className="text-left p-3 font-medium">2FA</th>
                <th className="text-right p-3 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-border hover:bg-muted/30">
                  <td className="p-3">
                    <div className="font-medium">{u.name}</div>
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                  </td>
                  <td className="p-3 text-xs">
                    {u.companies?.name ?? '—'}
                    {u.companies?.status === 'inactive' && (
                      <span className="ml-1 px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-[10px]">
                        inactiva
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    <select
                      value={u.role}
                      onChange={(e) => updateUser(u.id, { role: e.target.value })}
                      className="px-2 py-1 rounded border border-border bg-background text-xs"
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                      {/* Allow the current value even if it's a custom role */}
                      {!(ROLES as readonly string[]).includes(u.role) && (
                        <option value={u.role}>{u.role} (custom)</option>
                      )}
                    </select>
                  </td>
                  <td className="p-3">
                    <span
                      className={
                        u.twofa_enabled
                          ? 'inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300'
                          : 'inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                      }
                    >
                      {u.twofa_enabled ? 'activo' : 'no activo'}
                    </span>
                  </td>
                  <td className="p-3 text-right">
                    <button
                      onClick={() => deleteUser(u.id, u.email)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-red-300 text-red-600 text-xs hover:bg-red-50 dark:hover:bg-red-950/40"
                    >
                      <Trash2 className="w-3 h-3" /> Quitar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {inviteOpen && (
        <InviteModal
          companies={companies}
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            setInviteOpen(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function InviteModal({
  companies,
  onClose,
  onInvited,
}: {
  companies: CompanyOpt[];
  onClose: () => void;
  onInvited: () => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('admin');
  const [companyId, setCompanyId] = useState<string>(companies[0]?.id ?? '');
  const [allowed, setAllowed] = useState<string[]>(ALL_MODULES.map((m) => m.key));
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (k: string) =>
    setAllowed((a) => (a.includes(k) ? a.filter((x) => x !== k) : [...a, k]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/superadmin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, role, company_id: companyId, allowed_modules: allowed }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      onInvited();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : 'Error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="bg-card rounded-xl shadow-xl p-6 max-w-lg w-full space-y-4 max-h-[90vh] overflow-y-auto"
      >
        <h3 className="text-lg font-semibold">Invitar usuario</h3>
        {err && (
          <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800 text-red-800 dark:text-red-200 p-2 text-sm">
            {err}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium mb-1 inline-block">Nombre</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium mb-1 inline-block">Email</span>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium mb-1 inline-block">Empresa</span>
            <select
              required
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium mb-1 inline-block">Rol</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div>
          <p className="text-xs font-medium mb-2">Módulos permitidos</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 rounded-lg border border-border">
            {ALL_MODULES.map((m) => (
              <label key={m.key} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowed.includes(m.key)}
                  onChange={() => toggle(m.key)}
                  className="rounded border-border"
                />
                <span>{m.label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={submitting || !companyId}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Enviar invitación
          </button>
        </div>
      </form>
    </div>
  );
}
