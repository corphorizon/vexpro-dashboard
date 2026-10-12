'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { X, KeyRound, ShieldOff, Power, ClipboardList, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Notice } from '@/components/ui/notice';
import { Field, Input, Select } from '@/components/ui/field';
import { Segmented } from '@/components/ui/segmented';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionButton, ROW_ACTION_CLASS } from '@/components/ui/action-button';
import {
  USER_AUDIT_PREVIEW,
  atLimit,
  auditActionKind,
  twofaKind,
} from '@/components/superadmin/superadmin-model';
import { ALL_MODULES } from '../../_form';
import { BUILT_IN_ROLES, BUILT_IN_ROLE_LABELS } from '@/lib/roles';
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
//
// «Libro mayor» (2026-10-12): superficie `bg-card` + shadow-3; Field/Input/
// Select; el toggle de estado (esmeralda crudo) es un Segmented; los botones
// de seguridad son ActionButton (desactivar = `danger`, sin rojos crudos ni
// `dark:`); el historial dice cuando muestra exactamente las últimas
// USER_AUDIT_PREVIEW (puede haber más). Endpoints, payloads y confirmaciones
// sin cambios.
// ─────────────────────────────────────────────────────────────────────────────

// Roles rendered as { key, label } pairs for the <select>. Sourced from the
// single built-in roles export in auth-context so UI stays in sync with DB.
const ROLES: { key: string; label: string }[] = BUILT_IN_ROLES.map((key) => ({
  key,
  label: BUILT_IN_ROLE_LABELS[key],
}));

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
        const res = await apiFetch(
          `/api/superadmin/companies/${user.company_id}/users/${user.id}/audit?limit=${USER_AUDIT_PREVIEW}`,
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
      const res = await apiFetch(
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
      const res = await apiFetch(
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
      const res = await apiFetch(
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
      const res = await apiFetch(
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
        className="flex-1 bg-scrim"
      />

      {/* Panel */}
      <div className="h-full w-full max-w-xl overflow-y-auto border-l border-border bg-card text-foreground shadow-3">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-card px-5 py-3">
          <div className="min-w-0">
            <div className="text-[12px] text-text-3">Gestionar usuario</div>
            <div className="truncate text-[15px] font-semibold">{user.name || user.email}</div>
          </div>
          <button onClick={onClose} className={ROW_ACTION_CLASS} aria-label="Cerrar">
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <div className="space-y-6 p-5">
          {error && (
            <Notice kind="bad" title="No se pudo completar la acción">
              {error}
            </Notice>
          )}
          {toast && (
            <p role="status" className="flex items-center gap-2 text-[13px] font-medium text-pos">
              <Check aria-hidden className="size-4" /> {toast}
            </p>
          )}

          {/* SECTION: Basic info */}
          <section className="space-y-3">
            <h3 className={SECTION_TITLE}>Información básica</h3>
            <Field label="Nombre completo">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email" hint="Cambiar el email también actualiza la cuenta de login.">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <div className="flex flex-col gap-1">
              <span className="text-[12.5px] font-medium text-text-2">Estado</span>
              <Segmented<'active' | 'inactive'>
                aria-label="Estado del usuario"
                value={status}
                onChange={setStatus}
                options={[
                  { value: 'active', label: 'Activo' },
                  { value: 'inactive', label: 'Inactivo' },
                ]}
              />
              <span className="text-[12px] text-text-3">Se aplica al «Guardar cambios».</span>
            </div>
          </section>

          {/* SECTION: Role + permissions */}
          <section className="space-y-3">
            <h3 className={SECTION_TITLE}>Rol y permisos</h3>
            <Field label="Rol">
              <Select value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div>
              <p className="mb-1.5 text-[12.5px] font-medium text-text-2">Módulos accesibles</p>
              {availableModules.length === 0 ? (
                <Notice kind="info" title="Sin módulos activos">
                  Esta organización no tiene módulos activos. Activalos primero en Configuración.
                </Notice>
              ) : (
                <div className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-ui-md border border-border p-2 min-[420px]:grid-cols-2">
                  {availableModules.map((m) => {
                    const on = modules.includes(m.key);
                    return (
                      <label
                        key={m.key}
                        className="flex min-h-8 cursor-pointer select-none items-center gap-2 rounded-ui-sm px-1 text-[13px] hover:bg-surface-2 pointer-coarse:min-h-11"
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleModule(m.key)}
                          className="size-4 shrink-0 accent-brand-ink"
                        />
                        <span>{m.label}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <ActionButton variant="primary" onClick={handleSave} loading={saving}>
              Guardar cambios
            </ActionButton>
          </section>

          {/* SECTION: Security */}
          <section className="space-y-2">
            <h3 className={SECTION_TITLE}>Seguridad</h3>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-ui-md border border-border p-3">
              <div className="min-w-0">
                <div className="text-[13px] font-medium">Contraseña</div>
                <div className="text-[12px] text-text-3">Envía un email de recuperación a {user.email}.</div>
              </div>
              <ActionButton
                variant="secondary"
                onClick={handleResetPassword}
                disabled={busyAction !== null}
                loading={busyAction === 'reset'}
              >
                {busyAction !== 'reset' && <KeyRound aria-hidden className="size-4" />}
                Resetear contraseña
              </ActionButton>
            </div>

            <div className="rounded-ui-md border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-[13px] font-medium">Autenticador (2FA)</div>
                <StatusBadge
                  kind={twofaKind(user.twofa_enabled)}
                  label={user.twofa_enabled ? 'Activo' : 'No configurado'}
                />
              </div>
              <ActionButton
                variant="secondary"
                onClick={handleDisable2fa}
                disabled={!user.twofa_enabled || busyAction !== null}
                loading={busyAction === 'disable2fa'}
              >
                {busyAction !== 'disable2fa' && <ShieldOff aria-hidden className="size-4" />}
                Desactivar 2FA
              </ActionButton>
              {user.twofa_enabled && (
                <p className="mt-2 text-[12px] text-text-3">
                  Usá esto solo si el usuario perdió acceso a su autenticador. Deberá configurar 2FA de nuevo en su próximo login.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 rounded-ui-md border border-border p-3">
              <div className="min-w-0">
                <div className="text-[13px] font-medium">Acceso a la organización</div>
                <div className="text-[12px] text-text-3">
                  {status === 'active'
                    ? 'Desactivarlo le corta el login en esta organización al instante.'
                    : 'Está desactivado: no puede iniciar sesión en esta organización.'}
                </div>
              </div>
              <ActionButton
                variant={status === 'active' ? 'danger' : 'secondary'}
                onClick={handleDeactivate}
                disabled={busyAction !== null}
                loading={busyAction === 'deactivate'}
              >
                {busyAction !== 'deactivate' && <Power aria-hidden className="size-4" />}
                {status === 'active' ? 'Desactivar usuario' : 'Reactivar usuario'}
              </ActionButton>
            </div>
          </section>

          {/* SECTION: History */}
          <section className="space-y-2">
            <h3 className={cn(SECTION_TITLE, 'flex items-center gap-2')}>
              <ClipboardList aria-hidden className="size-4 text-text-3" /> Historial reciente
            </h3>
            {auditErr && (
              <Notice kind="bad" title="No se pudo cargar el historial">
                {auditErr}
              </Notice>
            )}
            {!audit && !auditErr && <Skeleton className="h-16" />}
            {audit && audit.length === 0 && (
              <p className="text-[13px] text-text-2">Este usuario aún no tiene actividad registrada.</p>
            )}
            {audit && audit.length > 0 && (
              <>
                <ul className="divide-y divide-border rounded-ui-md border border-border">
                  {audit.map((e) => (
                    <li key={e.id} className="px-3 py-2 text-[13px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <StatusBadge kind={auditActionKind(e.action)} label={e.action} />
                          <span className="truncate text-text-2">{e.module}</span>
                        </span>
                        <span className="shrink-0 whitespace-nowrap text-[12px] text-text-3">
                          {new Date(e.created_at).toLocaleString('es', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      {e.details && <div className="mt-1 line-clamp-2 text-[12px] text-text-3">{e.details}</div>}
                    </li>
                  ))}
                </ul>
                {atLimit(audit.length, USER_AUDIT_PREVIEW) && (
                  <p className="text-[12px] text-text-3">
                    Mostrando las últimas {USER_AUDIT_PREVIEW}; puede haber más en el historial completo.
                  </p>
                )}
              </>
            )}
            <a
              href={`/superadmin/companies/${user.company_id}?tab=audit`}
              className="inline-block text-[13px] font-medium text-brand-ink hover:underline"
            >
              Ver historial completo →
            </a>
          </section>
        </div>
      </div>
    </div>
  );
}

const SECTION_TITLE = 'text-[15px] font-semibold tracking-[-0.005em] text-foreground';
