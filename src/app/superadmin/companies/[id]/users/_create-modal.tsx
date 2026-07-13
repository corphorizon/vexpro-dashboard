'use client';

// ─────────────────────────────────────────────────────────────────────────────
// CreateUserModal — superadmin creates a new user inside the current
// tenant. Mirrors the field set that the existing PATCH already exposes
// (email, password, name, role, allowed_modules) so the UX feels
// consistent with the right-hand "Gestionar" panel.
//
// Posts to POST /api/superadmin/companies/:id/users. On success, calls
// `onCreated(user)` so the parent can prepend the new row optimistically.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { X, Loader2, UserPlus } from 'lucide-react';
import { BUILT_IN_ROLES, BUILT_IN_ROLE_LABELS, ROLE_DEFAULT_MODULES } from '@/lib/auth-context';
import { ALL_MODULES } from '../../_form';
import type { CompanyUser } from './page';

interface Props {
  companyId: string;
  companyActiveModules: string[];
  open: boolean;
  onClose: () => void;
  onCreated: (user: CompanyUser) => void;
}

export function CreateUserModal({
  companyId,
  companyActiveModules,
  open,
  onClose,
  onCreated,
}: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<string>('socio');
  const [modules, setModules] = useState<string[]>(ROLE_DEFAULT_MODULES.socio ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on open.
  useEffect(() => {
    if (!open) return;
    setName('');
    setEmail('');
    setPassword('');
    setRole('socio');
    setModules(ROLE_DEFAULT_MODULES.socio ?? []);
    setError(null);
  }, [open]);

  // Close on ESC.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Only modules that the COMPANY has enabled are eligible.
  const eligibleModules = ALL_MODULES.filter((m) => companyActiveModules.includes(m.key));

  const toggleModule = (key: string) =>
    setModules((m) => (m.includes(key) ? m.filter((x) => x !== key) : [...m, key]));

  const onRoleChange = (next: string) => {
    setRole(next);
    // Smart-fill the module set with the role's defaults so admins don't
    // have to tick boxes manually for the common case.
    const defaults = ROLE_DEFAULT_MODULES[next] ?? [];
    setModules(defaults.filter((m) => companyActiveModules.includes(m)));
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/superadmin/companies/${companyId}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          password,
          role,
          allowed_modules: modules,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      onCreated(json.user as CompanyUser);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error creando el usuario');
    } finally {
      setSaving(false);
    }
  };

  const valid =
    !!email.trim() &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    password.length >= 8 &&
    !!name.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-background">
          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5" />
            <h2 className="text-lg font-semibold">Agregar usuario</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-muted"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800 text-red-800 dark:text-red-200 p-2.5 text-xs">
              {error}
            </div>
          )}

          <div>
            <label className="text-xs font-medium block mb-1">Nombre</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
              placeholder="Juan Pérez"
              autoFocus
            />
          </div>

          <div>
            <label className="text-xs font-medium block mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
              placeholder="usuario@empresa.com"
            />
          </div>

          <div>
            <label className="text-xs font-medium block mb-1">Contraseña inicial</label>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm font-mono"
              placeholder="Mínimo 8 caracteres"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              El usuario puede cambiarla luego desde su perfil o pidiéndola por email.
            </p>
          </div>

          <div>
            <label className="text-xs font-medium block mb-1">Rol</label>
            <select
              value={role}
              onChange={(e) => onRoleChange(e.target.value)}
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm"
            >
              {BUILT_IN_ROLES.map((r) => (
                <option key={r} value={r}>
                  {BUILT_IN_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-medium block mb-2">Módulos permitidos</label>
            <div className="grid grid-cols-2 gap-1.5 max-h-48 overflow-y-auto p-2 border border-border rounded-md">
              {eligibleModules.length === 0 ? (
                <p className="col-span-2 text-xs text-muted-foreground italic p-2">
                  Esta empresa no tiene módulos activos.
                </p>
              ) : (
                eligibleModules.map((m) => (
                  <label
                    key={m.key}
                    className="flex items-center gap-2 text-xs p-1.5 rounded hover:bg-muted/40 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={modules.includes(m.key)}
                      onChange={() => toggleModule(m.key)}
                    />
                    <span>{m.label}</span>
                  </label>
                ))
              )}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Defaults aplicados según el rol — podés ajustarlos manualmente.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 p-5 border-t border-border sticky bottom-0 bg-background">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 py-2 rounded-md border border-border text-sm hover:bg-muted disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={!valid || saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            {saving ? 'Creando…' : 'Crear usuario'}
          </button>
        </div>
      </div>
    </div>
  );
}
