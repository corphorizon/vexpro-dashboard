'use client';

// ─────────────────────────────────────────────────────────────────────────────
// CreateUserModal — superadmin creates a new user inside the current
// tenant. Mirrors the field set that the existing PATCH already exposes
// (email, password, name, role, allowed_modules) so the UX feels
// consistent with the right-hand "Gestionar" panel.
//
// Posts to POST /api/superadmin/companies/:id/users. On success, calls
// `onCreated(user)` so the parent can prepend the new row optimistically.
//
// «Libro mayor» (2026-10-12): modal rounded-ui-xl + shadow-3 con pie fijo,
// Field/Input/Select, ActionButton. El mínimo de la contraseña sale de
// PASSWORD_MIN_LENGTH (auth-form.ts, el mismo 8 que valida el endpoint) en
// vez de un 8 suelto. Payload y validación sin cambios.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { X, UserPlus } from 'lucide-react';
import { PASSWORD_MIN_LENGTH } from '@/lib/auth-form';
import { Notice } from '@/components/ui/notice';
import { Field, Input, Select } from '@/components/ui/field';
import { ActionButton, ROW_ACTION_CLASS } from '@/components/ui/action-button';
import { ROLE_DEFAULT_MODULES } from '@/lib/auth-context';
import { BUILT_IN_ROLES, BUILT_IN_ROLE_LABELS } from '@/lib/roles';
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
    password.length >= PASSWORD_MIN_LENGTH &&
    !!name.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-user-title"
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-ui-xl border border-border bg-card text-foreground shadow-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h2 id="create-user-title" className="flex items-center gap-2 text-[15px] font-semibold">
            <UserPlus aria-hidden className="size-4 text-text-3" />
            Agregar usuario
          </h2>
          <button onClick={onClose} className={ROW_ACTION_CLASS} aria-label="Cerrar">
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-5">
          {error && (
            <Notice kind="bad" title="No se pudo crear el usuario">
              {error}
            </Notice>
          )}

          <Field label="Nombre" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Juan Pérez" autoFocus />
          </Field>

          <Field label="Email" required>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="usuario@empresa.com"
            />
          </Field>

          <Field
            label="Contraseña inicial"
            required
            hint="El usuario puede cambiarla luego desde su perfil o pidiéndola por email."
          >
            <Input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="font-mono"
              placeholder={`Mínimo ${PASSWORD_MIN_LENGTH} caracteres`}
            />
          </Field>

          <Field label="Rol">
            <Select value={role} onChange={(e) => onRoleChange(e.target.value)}>
              {BUILT_IN_ROLES.map((r) => (
                <option key={r} value={r}>
                  {BUILT_IN_ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          </Field>

          <div>
            <p className="mb-1.5 text-[12.5px] font-medium text-text-2">Módulos permitidos</p>
            {eligibleModules.length === 0 ? (
              <Notice kind="info" title="Sin módulos activos">
                Esta empresa no tiene módulos activos.
              </Notice>
            ) : (
              <div className="grid max-h-48 grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto rounded-ui-md border border-border p-2 min-[420px]:grid-cols-2">
                {eligibleModules.map((m) => (
                  <label
                    key={m.key}
                    className="flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-ui-sm px-1 text-[13px] hover:bg-surface-2 pointer-coarse:min-h-11"
                  >
                    <input
                      type="checkbox"
                      checked={modules.includes(m.key)}
                      onChange={() => toggleModule(m.key)}
                      className="size-4 shrink-0 accent-brand-ink"
                    />
                    <span>{m.label}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1 text-[12px] text-text-3">
              Defaults aplicados según el rol — podés ajustarlos manualmente.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <ActionButton variant="secondary" onClick={onClose} disabled={saving}>
            Cancelar
          </ActionButton>
          <ActionButton variant="primary" onClick={submit} disabled={!valid} loading={saving}>
            {!saving && <UserPlus aria-hidden className="size-4" />}
            {saving ? 'Creando…' : 'Crear usuario'}
          </ActionButton>
        </div>
      </div>
    </div>
  );
}
