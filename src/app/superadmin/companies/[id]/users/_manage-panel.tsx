'use client';

import { useEffect, useState } from 'react';
import { X, Loader2, KeyRound, ShieldOff, Power, ClipboardList, Check } from 'lucide-react';
import { ALL_MODULES } from '../../_form';
import type { CompanyUser } from './page';

// ─────────────────────────────────────────────────────────────────────────────
// ManageUserPanel — right-hand slide-over for a single user.
//
// Sections:
//   · Información básica  (name, email, status toggle)
//   · Rol y permisos      (role selector + per-module checkboxes)
//   · Seguridad           (reset password, disable 2FA, deactivate user)
//   · Historial           (last 5 audit entries + link to full audit)
//
// State is local — on save we POST to /api/superadmin/.../users/:userId and
// bubble the fresh row back up via onUpdated(). Failures surface in a banner
// without closing the panel so the user can retry.
// ─────────────────────────────────────────────────────────────────────────────

const ROLES: { key: string; label: string }[] = [
  { key: 'admin', label: 'Admin' },
  { key: 'socio', label: 'Socio' },
  { key: 'auditor', label: 'Auditor' },
  { key: 'soporte', label: 'Soporte' },
  { key: 'hr', label: 'HR' },
  { key: 'invitado', label: 'Invitado' },
];

interface AuditEntry {
  id: string;
  action: string;
  module: string;
  details: string | null;
  created_at: string;
}

interface Props {
  user: CompanyUser;
  companyActiveModules: string[];
  onClose: () => void;
  onUpdated: (u: CompanyUser) => void;
}

export function ManageUserPanel({ user, companyActiveModules, onClose, onUpdated }: Props) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState(user.role);
  const [status, setStatus] = useState<'active' | 'inactive'>(user.status);
  const [modules, setModules] = useState<string[]>(user.allowed_modules ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<null | 'reset' | 'disable2fa' | 'deactivate'>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditErr, setAuditErr] = useState<string | null>(null);

  // Load audit on mount.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `/api/superadmin/companies/${user.company_id}/users/${user.id}/audit?limit=5`,
        );
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
        setAudit(json.entries);
      } catch (err) {
        setAuditErr(err instanceof Error ? err.message : 'No se pudo cargar el historial');
      }
    })();
  }, [user.company_id, user.id]);

  // Close on ESC.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggleModule = (key: string) => {
    setModules((m) => (m.includes(key) ? m.filter((x) => x !== key) : [...m, key]));
  };

  const flashToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/superadmin/companies/${user.company_id}/users/${user.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            email: email.trim(),
            role,
            status,
            allowed_modules: modules,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      onUpdated(json.user);
      flashToast('Cambios guardados');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando');
    } finally {
      setSaving(false);
    }
  };

  const handleResetPassword = async () => {
    if (!confirm(`¿Enviar email de reset de contraseña a ${user.email}?`)) return;
    setBusyAction('reset');
    setError(null);
    try {
      const res = await fetch(
        `/api/superadmin/companies/${user.company_id}/users/${user.id}/reset-password`,
        { method: 'POST' },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      flashToast('Email de recuperación enviado');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error enviando reset');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDisable2fa = async () => {
    if (
      !confirm(
        `¿Desactivar 2FA de ${user.email}?\n\nEl usuario deberá configurar 2FA de nuevo en su próximo login.`,
      )
    ) {
      return;
    }
    setBusyAction('disable2fa');
    setError(null);
    try {
      const res = await fetch(
        `/api/superadmin/companies/${user.company_id}/users/${user.id}/disable-2fa`,
        { method: 'POST' },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      onUpdated({ ...user, twofa_enabled: false });
      flashToast('2FA desactivado');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desactivando 2FA');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeactivate = async () => {
    const nextStatus = status === 'active' ? 'inactive' : 'active';
    const msg =
      nextStatus === 'inactive'
        ? `¿Desactivar a ${user.email}? No podrá iniciar sesión en esta organización hasta que lo reactives.`
        : `¿Reactivar a ${user.email}?`;
    if (!confirm(msg)) return;

    setBusyAction('deactivate');
    setError(null);
    try {
      const res = await fetch(
        `/api/superadmin/companies/${user.company_id}/users/${user.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setStatus(nextStatus);
      onUpdated(json.user);
      flashToast(nextStatus === 'inactive' ? 'Usuario desactivado' : 'Usuario reactivado');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error actualizando estado');
    } finally {
      setBusyAction(null);
    }
  };

  const availableModules = ALL_MODULES.filter((m) => companyActiveModules.includes(m.key));

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Gestionar usuario">
      {/* Backdrop */}
      <button
        aria-label="Cerrar"
        onClick={onClose}
        className="flex-1 bg-black/40"
      />

      {/* Panel */}
      <div className="w-full max-w-xl h-full bg-background border-l border-border overflow-y-auto shadow-xl">
        <div className="sticky top-0 z-10 bg-background border-b border-border px-5 py-3 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">Gestionar usuario</div>
            <div className="font-semibold truncate">{user.name || user.email}</div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-muted"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-6">
          {error && (
            <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800 text-red-800 dark:text-red-200 p-3 text-sm">
              {error}
            </div>
          )}
          {toast && (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 p-3 text-sm flex items-center gap-2">
              <Check className="w-4 h-4" /> {toast}
            </div>
          )}

          {/* SECTION: Basic info */}
          <section>
            <h3 className="text-sm font-semibold mb-3">Información básica</h3>
            <div className="space-y-3">
              <Field label="Nombre completo">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                />
              </Field>
              <Field label="Email">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Cambiar el email también actualiza la cuenta de login.
                </p>
              </Field>
              <Field label="Estado">
                <button
                  type="button"
                  onClick={() => setStatus((s) => (s === 'active' ? 'inactive' : 'active'))}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    status === 'active'
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                      : 'border-border bg-muted text-muted-foreground'
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      status === 'active' ? 'bg-emerald-500' : 'bg-muted-foreground/50'
                    }`}
                  />
                  {status === 'active' ? 'Activo' : 'Inactivo'}
                </button>
              </Field>
            </div>
          </section>

          {/* SECTION: Role + permissions */}
          <section>
            <h3 className="text-sm font-semibold mb-3">Rol y permisos</h3>
            <Field label="Rol">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              >
                {ROLES.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>

            <div className="mt-3">
              <p className="text-xs font-medium mb-2">Módulos accesibles</p>
              {availableModules.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Esta organización no tiene módulos activos. Actívalos primero en Configuración.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-2 p-3 rounded-lg border border-border bg-card">
                  {availableModules.map((m) => {
                    const on = modules.includes(m.key);
                    return (
                      <label key={m.key} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleModule(m.key)}
                          className="rounded border-border"
                        />
                        <span>{m.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mt-4">
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Guardar cambios
              </button>
            </div>
          </section>

          {/* SECTION: Security */}
          <section>
            <h3 className="text-sm font-semibold mb-3">Seguridad</h3>

            <div className="space-y-2">
              <button
                onClick={handleResetPassword}
                disabled={busyAction !== null}
                className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
              >
                {busyAction === 'reset' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <KeyRound className="w-4 h-4" />
                )}
                Resetear contraseña
                <span className="ml-auto text-xs text-muted-foreground">
                  envía email de recuperación
                </span>
              </button>

              <div className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-sm font-medium">Autenticador (2FA)</div>
                  <span
                    className={`text-xs ${
                      user.twofa_enabled
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {user.twofa_enabled ? 'Activo' : 'No configurado'}
                  </span>
                </div>
                <button
                  onClick={handleDisable2fa}
                  disabled={!user.twofa_enabled || busyAction !== null}
                  className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {busyAction === 'disable2fa' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ShieldOff className="w-4 h-4" />
                  )}
                  Desactivar 2FA
                </button>
                {user.twofa_enabled && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Usa esto solo si el usuario perdió acceso a su autenticador. Deberá configurar 2FA de nuevo en su próximo login.
                  </p>
                )}
              </div>

              <button
                onClick={handleDeactivate}
                disabled={busyAction !== null}
                className={`w-full inline-flex items-center gap-2 px-3 py-2 rounded-lg border text-sm disabled:opacity-50 ${
                  status === 'active'
                    ? 'border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950/40'
                    : 'border-border hover:bg-muted'
                }`}
              >
                {busyAction === 'deactivate' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Power className="w-4 h-4" />
                )}
                {status === 'active' ? 'Desactivar usuario' : 'Reactivar usuario'}
              </button>
            </div>
          </section>

          {/* SECTION: History */}
          <section>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <ClipboardList className="w-4 h-4" /> Historial reciente
            </h3>
            {auditErr && (
              <div className="text-xs text-red-700 dark:text-red-400">{auditErr}</div>
            )}
            {!audit && !auditErr && (
              <div className="text-xs text-muted-foreground">Cargando…</div>
            )}
            {audit && audit.length === 0 && (
              <div className="text-xs text-muted-foreground">
                Este usuario aún no tiene actividad registrada.
              </div>
            )}
            {audit && audit.length > 0 && (
              <ul className="space-y-2">
                {audit.map((e) => (
                  <li key={e.id} className="rounded-lg border border-border p-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">
                        {e.action} · {e.module}
                      </span>
                      <span className="text-muted-foreground">
                        {new Date(e.created_at).toLocaleString('es', {
                          day: '2-digit',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    {e.details && (
                      <div className="mt-1 text-muted-foreground line-clamp-2">{e.details}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <a
              href={`/superadmin/companies/${user.company_id}?tab=audit`}
              className="inline-block mt-2 text-xs text-[var(--color-primary)] hover:underline"
            >
              Ver historial completo →
            </a>
          </section>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium mb-1 inline-block">{label}</span>
      {children}
    </label>
  );
}
