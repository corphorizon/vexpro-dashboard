'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /usuarios — alta, edición, módulos, reseteo de contraseña / 2FA y baja.
//
// «Libro mayor» (2026-10-12): Panel + FinTable (en < 720 px cada usuario es
// una tarjeta: nombre + email, y debajo rol / 2FA / activación; acciones a la
// derecha), formularios con Field (borde `control-border` 3:1, label visible),
// estados con StatusBadge (users-view.ts decide el color, con test) y
// botones ActionButton (el primario era `bg-[var(--color-primary)]
// text-white`: blanco fijo). Sale toda la paleta cruda (violeta, esmeralda,
// ámbar, índigo, rojo) y sus `dark:`.
//
// NO cambió: permisos, roles, invitaciones, 2FA, borrado ni llamadas a la API
// (mismos endpoints, mismos payloads, mismas funciones de useAuth).
//
// Fallos que no daban error, corregidos en la pantalla:
//   · Resetear contraseña: si el servidor rechazaba el cambio, `resetPassword`
//     devolvía false y el modal… no decía nada. Ahora lo dice.
//   · Lista de usuarios vacía: `fetchAllUsers` (lib) devuelve [] si la API
//     falla y la tabla decía «Usuarios (0)». Con alguien mirando la pantalla
//     una lista vacía es imposible: se avisa y el conteo es «—».
//   · Roles personalizados: el catch vacío dejaba el selector sin ellos sin
//     avisar. Ahora se avisa (salvo 403: un no-admin no los puede leer).
//   · Reenviar invitación: `alert()` del navegador → aviso en la pantalla.
//
// DESCARTADO: la barra de pestañas con una sola pestaña («Usuarios»). La de
// Roles está oculta (ver nota abajo) y una pestaña sola no comunica nada; el
// estado y la rama de RolesPanel quedan para reactivarla.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth, ROLE_LABELS, ROLE_DESCRIPTIONS, ROLE_DEFAULT_MODULES, MODULE_LABELS, roleCanWrite, type User } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { RolesPanel } from '@/components/settings/roles-panel';
import { useI18n } from '@/lib/i18n';
import { apiFetch } from '@/lib/api-fetch';
import { useConfirm } from '@/lib/use-confirm';
import { cn } from '@/lib/utils';
import { Users, Plus, Pencil, Trash2, X, KeyRound, ShieldOff, Eye, Send } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { Field, Input, Select } from '@/components/ui/field';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { ActionButton, ROW_ACTION_CLASS } from '@/components/ui/action-button';
import { ModuleForbidden } from '@/components/module-route-guard';
import { SuccessNote } from '@/components/success-note';
// Single source of truth for the module catalog — same list and order the
// superadmin form uses, so /usuarios and /superadmin/users stay in sync.
import { ALL_MODULES } from '@/app/superadmin/companies/_form';
import {
  parseCustomRoles,
  pendingActivationKind,
  splitModules,
  twofaKind,
  usersListSuspect,
  type CustomRolesState,
} from './users-view';

const ALL_ROLES: Array<User['role']> = ['admin', 'socio', 'auditor', 'soporte', 'hr', 'invitado'];

interface CustomRoleOption {
  id: string;
  name: string;
  description: string | null;
  base_role: string;
  default_modules: string[];
}

interface UserForm {
  name: string;
  email: string;
  role: User['role'];
  allowed_modules: string[];
}

const emptyForm: UserForm = {
  name: '',
  email: '',
  role: 'socio',
  allowed_modules: ROLE_DEFAULT_MODULES['socio'],
};

/** Modal «Libro mayor» (mismo esqueleto que /periodos): scrim, `rounded-ui-xl`, `shadow-3`. */
function Dialog({
  title,
  onClose,
  closeLabel,
  children,
}: {
  title: string;
  onClose: () => void;
  closeLabel: string;
  children: React.ReactNode;
}) {
  const id = 'usr-dialog-title';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className="flex max-h-[85vh] w-full max-w-sm flex-col rounded-ui-xl border border-border bg-card shadow-3"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h2 id={id} className="text-[15px] font-semibold text-foreground">{title}</h2>
          <button type="button" onClick={onClose} className={ROW_ACTION_CLASS} aria-label={closeLabel}>
            <X aria-hidden className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

export default function UsuariosPage() {
  const { t } = useI18n();
  const { user, users, createUser, updateUser, deleteUser, resetPassword } = useAuth();
  const canAccess = useModuleAccess('users');
  const { confirm, Modal: ConfirmModal } = useConfirm();
  // Two tabs inside /usuarios: the user list (default) and custom roles
  // (moved here from the old /configuraciones page).
  //
  // NOTE: The Roles tab is temporarily HIDDEN because the backing logic is
  // half-built: the custom_roles table and RolesPanel UI exist and can
  // create/edit rows, but hasModuleAccess() in auth-context.tsx only
  // recognises the 6 BUILT_IN_ROLES — custom roles don't grant module
  // permissions yet. Re-enable this tab once the permission resolver wires up
  // `effective_role`. Keeping the RolesPanel import and the 'roles' branch
  // below so nothing rots while the feature is paused.
  // TODO: Custom roles UI — pendiente wirear con hasModuleAccess antes de activar.
  const [activeTab] = useState<'users' | 'roles'>('users');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<UserForm>(emptyForm);
  // Movido aquí desde justo antes de handleResendInvite (estaba después del
  // early-return `if (!canAccess)`, lo que disparaba react-hooks/rules-of-hooks
  // en CI 2026-06-06). Los hooks deben declararse antes de cualquier exit.
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [inviteMsg, setInviteMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [resetPwUser, setResetPwUser] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetSuccess, setResetSuccess] = useState(false);
  const [resetPwError, setResetPwError] = useState(false);
  const [resetPwSaving, setResetPwSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reset2faUser, setReset2faUser] = useState<User | null>(null);
  const [reset2faLoading, setReset2faLoading] = useState(false);
  const [reset2faError, setReset2faError] = useState<string | null>(null);
  const [customRoles, setCustomRoles] = useState<CustomRoleOption[]>([]);
  const [customRolesState, setCustomRolesState] = useState<CustomRolesState>('loading');

  // Ref al panel del form de creación/edición. Cuando un admin hace click
  // en "Editar" desde una fila al fondo de la tabla, el form se monta
  // arriba de la lista — sin este scroll, el cambio era invisible y
  // parecía que el botón no hacía nada.
  const formCardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (showForm) {
      // requestAnimationFrame asegura que el panel ya esté en el DOM
      // (mountado por el conditional render) antes de scrollear.
      requestAnimationFrame(() => {
        formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [showForm]);

  // Fetch per-company custom roles — admin can assign them alongside built-ins.
  // Sigue siendo no fatal, pero una falla se avisa (users-view.ts).
  const loadCustomRoles = useCallback(() => {
    apiFetch('/api/admin/custom-roles')
      .then(async (r) => {
        const json = await r.json().catch(() => null);
        const parsed = parseCustomRoles<CustomRoleOption>(r.status, r.ok, json);
        setCustomRoles(parsed.roles);
        setCustomRolesState(parsed.state);
      })
      .catch(() => setCustomRolesState('error'));
  }, []);

  useEffect(() => {
    loadCustomRoles();
  }, [loadCustomRoles]);

  if (!canAccess) {
    return <ModuleForbidden moduleKey="users" />;
  }

  const handleCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const handleEdit = (u: User) => {
    setEditingId(u.id);
    setForm({
      name: u.name,
      email: u.email,
      role: u.role,
      allowed_modules: [...u.allowed_modules],
    });
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setFormError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      if (editingId) {
        await updateUser(editingId, {
          name: form.name,
          email: form.email,
          role: form.role,
          allowed_modules: form.allowed_modules,
        });
      } else {
        // Figure out the effective capability tier for the UI. Built-ins map
        // to themselves; custom roles resolve via their base_role.
        const custom = customRoles.find(c => c.name === form.role);
        const effectiveRole = (custom?.base_role ?? form.role) as User['role'];
        await createUser({
          name: form.name,
          email: form.email,
          role: form.role,
          effective_role: effectiveRole,
          company_id: user?.company_id || '',
          allowed_modules: form.allowed_modules,
          twofa_enabled: false,
          // Created via the in-company flow — never a superadmin.
          is_superadmin: false,
          force_2fa_setup: true,         // new users must set up 2FA on first login
          must_change_password: true,    // server enforces this anyway; mantenemos consistencia
        });
      }
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('lmAdm.users.saveError'));
    } finally {
      setSaving(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPwUser || !newPassword) return;
    setResetPwError(false);
    setResetPwSaving(true);
    const ok = await resetPassword(resetPwUser.email, newPassword);
    setResetPwSaving(false);
    if (ok) {
      setResetSuccess(true);
      setTimeout(() => {
        setResetPwUser(null);
        setNewPassword('');
        setResetSuccess(false);
      }, 2000);
    } else {
      // Antes: nada. El modal quedaba abierto sin decir que falló.
      setResetPwError(true);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteUser(id);
      setDeleteConfirm(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('lmAdm.users.deleteError'));
      setDeleteConfirm(null);
    }
  };

  // Reenviar invitación: regenera el token y manda el correo de nuevo.
  // Solo aplica a usuarios con must_change_password=true (todavía no
  // activaron su cuenta) y que no son admin. El useState se declara
  // arriba con los demás (rules-of-hooks).
  const doResendInvite = async (u: User) => {
    setResendingId(u.id);
    setInviteMsg(null);
    try {
      const res = await apiFetch(`/api/admin/users/${u.id}/resend-invite`, {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setInviteMsg({ ok: false, text: json.error || t('lmAdm.users.resendError') });
        return;
      }
      setInviteMsg({ ok: true, text: t('lmAdm.users.resendOk', { email: u.email }) });
    } catch (err) {
      setInviteMsg({ ok: false, text: err instanceof Error ? err.message : t('lmAdm.users.networkError') });
    } finally {
      setResendingId(null);
    }
  };

  const handleResendInvite = (u: User) => {
    confirm(t('lmAdm.users.resendConfirm', { email: u.email }), () => void doResendInvite(u), {
      confirmLabel: t('users.resendInvite'),
    });
  };

  const handleReset2fa = async () => {
    if (!reset2faUser) return;
    setReset2faLoading(true);
    setReset2faError(null);
    try {
      const res = await apiFetch('/api/admin/reset-user-2fa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: reset2faUser.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || t('lmAdm.users.reset2faError'));
      }
      // Reflect new state in the local list so the UI updates immediately
      updateUser(reset2faUser.id, { twofa_enabled: false });
      setReset2faUser(null);
    } catch (err) {
      setReset2faError(err instanceof Error ? err.message : t('lmAdm.users.reset2faError'));
    } finally {
      setReset2faLoading(false);
    }
  };

  const toggleModule = (mod: string) => {
    setForm(prev => ({
      ...prev,
      allowed_modules: prev.allowed_modules.includes(mod)
        ? prev.allowed_modules.filter(m => m !== mod)
        : [...prev.allowed_modules, mod],
    }));
  };

  const formCustom = customRoles.find(c => c.name === form.role);
  const formEffectiveRole = formCustom?.base_role ?? form.role;
  const formWrites = roleCanWrite(formEffectiveRole);
  const checkedModules = ALL_MODULES.filter((m) => form.allowed_modules.includes(m.key)).length;

  const listSuspect = usersListSuspect(users, Boolean(user));

  const moduleName = (mod: string) => MODULE_LABELS[mod] || mod;

  const columns: FinColumn<User>[] = [
    {
      key: 'name',
      header: t('users.name'),
      cell: (u) => u.name,
      meta: (u) => u.email,
      mobileMeta: (u) => (
        <>
          <StatusBadge kind="neutral" label={ROLE_LABELS[u.role] || u.role} />
          <StatusBadge kind={twofaKind(u.twofa_enabled)} label={`2FA · ${u.twofa_enabled ? t('lmAdm.users.twofaOn') : t('lmAdm.users.twofaOff')}`} />
          {u.must_change_password && <StatusBadge kind={pendingActivationKind()} label={t('users.pendingActivation')} />}
        </>
      ),
    },
    {
      key: 'role',
      header: t('users.role'),
      hideSm: true,
      // El rol no es dinero ni estado del flujo: gris (antes admin en verde).
      cell: (u) => <StatusBadge kind="neutral" label={ROLE_LABELS[u.role] || u.role} />,
    },
    {
      key: 'modules',
      header: t('users.modules'),
      hideSm: true,
      cell: (u) => {
        const { shown, hidden } = splitModules(u.allowed_modules);
        return (
          <div className="flex flex-wrap gap-1 py-1.5">
            {shown.map((mod) => (
              <span key={mod} className="rounded-ui-sm bg-surface-2 px-1.5 py-0.5 text-[12px] text-text-2">
                {moduleName(mod)}
              </span>
            ))}
            {hidden.length > 0 && (
              <span
                className="rounded-ui-sm border border-border-strong px-1.5 py-0.5 text-[12px] tabular-nums text-text-2"
                title={hidden.map(moduleName).join(', ')}
              >
                +{hidden.length}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'twofa',
      header: '2FA',
      hideSm: true,
      cell: (u) => (
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge kind={twofaKind(u.twofa_enabled)} label={u.twofa_enabled ? t('lmAdm.users.twofaOn') : t('lmAdm.users.twofaOff')} />
          {u.must_change_password && <StatusBadge kind={pendingActivationKind()} label={t('users.pendingActivation')} />}
        </div>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('common.actions')}</span>,
      align: 'right',
      cardSide: 'right',
      cell: (u) =>
        // Para usuarios con role='admin', el admin de empresa no puede
        // gestionarlos — solo el superadmin. Mostramos un guion en vez de
        // los botones.
        u.role === 'admin' ? (
          <span className="text-[12.5px] text-text-3" title={t('lmAdm.users.adminOnlySuperadmin')}>—</span>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-0.5">
            {/* Reenviar invitación: solo si todavía no creó su contraseña. */}
            {u.must_change_password && (
              <button
                type="button"
                onClick={() => handleResendInvite(u)}
                disabled={resendingId === u.id}
                className={ROW_ACTION_CLASS}
                title={t('users.resendInvite')}
                aria-label={t('users.resendInvite')}
                aria-busy={resendingId === u.id || undefined}
              >
                <Send aria-hidden className={cn('size-4', resendingId === u.id && 'animate-pulse')} strokeWidth={1.75} />
              </button>
            )}
            <button
              type="button"
              onClick={() => handleEdit(u)}
              className={ROW_ACTION_CLASS}
              title={t('common.edit')}
              aria-label={t('common.edit')}
            >
              <Pencil aria-hidden className="size-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={() => { setResetPwUser(u); setNewPassword(''); setResetSuccess(false); setResetPwError(false); }}
              className={ROW_ACTION_CLASS}
              title={t('lmAdm.users.resetPw')}
              aria-label={t('lmAdm.users.resetPw')}
            >
              <KeyRound aria-hidden className="size-4" strokeWidth={1.75} />
            </button>
            {u.twofa_enabled && (
              <button
                type="button"
                onClick={() => { setReset2faUser(u); setReset2faError(null); }}
                className={ROW_ACTION_CLASS}
                title={t('lmAdm.users.reset2fa')}
                aria-label={t('lmAdm.users.reset2fa')}
              >
                <ShieldOff aria-hidden className="size-4" strokeWidth={1.75} />
              </button>
            )}
            {u.id !== user?.id && (
              deleteConfirm === u.id ? (
                <span className="flex flex-wrap items-center justify-end gap-1 pl-1">
                  <ActionButton variant="danger" onClick={() => void handleDelete(u.id)}>
                    {t('users.confirm')}
                  </ActionButton>
                  <ActionButton variant="ghost" onClick={() => setDeleteConfirm(null)}>
                    {t('common.cancel')}
                  </ActionButton>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(u.id)}
                  className={cn(ROW_ACTION_CLASS, 'hover:text-neg')}
                  title={t('common.delete')}
                  aria-label={t('common.delete')}
                >
                  <Trash2 aria-hidden className="size-4" strokeWidth={1.75} />
                </button>
              )
            )}
          </div>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      {ConfirmModal}
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        icon={Users}
        actions={
          activeTab === 'users' ? (
            <ActionButton variant="primary" onClick={handleCreate}>
              <Plus aria-hidden className="size-[15px]" strokeWidth={1.75} />
              {t('users.create')}
            </ActionButton>
          ) : undefined
        }
      />

      {/* Roles tab body still wired for future re-enable — never shown today. */}
      {activeTab === 'roles' && <RolesPanel />}

      {inviteMsg && (inviteMsg.ok
        ? <SuccessNote>{inviteMsg.text}</SuccessNote>
        : <Notice kind="bad" title={inviteMsg.text} />)}

      {/* Form — envuelto en div para anclar el ref de scroll-into-view. */}
      {activeTab === 'users' && showForm && (
        <div ref={formCardRef} className="scroll-mt-4">
          <Panel
            title={editingId ? t('users.edit') : t('users.create')}
            hint={!editingId ? t('lmAdm.users.inviteHint') : undefined}
            actions={
              <button type="button" onClick={closeForm} className={ROW_ACTION_CLASS} aria-label={t('common.cancel')}>
                <X aria-hidden className="size-4" strokeWidth={1.75} />
              </button>
            }
          >
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label={t('users.name')} required>
                  <Input
                    type="text"
                    value={form.name}
                    onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                    autoComplete="name"
                  />
                </Field>
                <Field label={t('users.email')} required>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm(prev => ({ ...prev, email: e.target.value }))}
                    autoComplete="email"
                  />
                </Field>
                {/* Sin campo Contraseña — el flujo nuevo manda invitación
                    por email. El usuario crea su propia contraseña en
                    /reset-password?token=...&mode=setup tras click en el
                    link. Aviso al admin en el hint del panel. */}
                <Field
                  label={t('users.role')}
                  hint={formCustom?.description
                    ?? ROLE_DESCRIPTIONS[form.role]
                    ?? t('lmAdm.users.customRoleFallback')}
                >
                  <Select
                    value={form.role}
                    onChange={(e) => {
                      const newRole = e.target.value;
                      const custom = customRoles.find(c => c.name === newRole);
                      if (custom) {
                        setForm(prev => ({
                          ...prev,
                          role: newRole as User['role'],
                          allowed_modules: custom.default_modules,
                        }));
                      } else {
                        setForm(prev => ({
                          ...prev,
                          role: newRole as User['role'],
                          allowed_modules: ROLE_DEFAULT_MODULES[newRole] || [],
                        }));
                      }
                    }}
                  >
                    <optgroup label={t('lmAdm.users.systemRoles')}>
                      {/* `admin` se excluye: solo el superadmin puede crear
                          usuarios con rol admin (vía /superadmin/users). El
                          endpoint /api/admin/create-user también lo bloquea
                          server-side con 403, esto es defensa en profundidad. */}
                      {ALL_ROLES.filter(role => role !== 'admin').map(role => (
                        <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                      ))}
                    </optgroup>
                    {customRoles.length > 0 && (
                      <optgroup label={t('lmAdm.users.customRoles')}>
                        {customRoles.map(c => (
                          <option key={c.id} value={c.name}>{c.name}</option>
                        ))}
                      </optgroup>
                    )}
                  </Select>
                </Field>
              </div>

              {customRolesState === 'error' && (
                <Notice
                  kind="pend"
                  title={t('lmAdm.users.customRolesErrorTitle')}
                  action={
                    <ActionButton
                      variant="secondary"
                      onClick={() => { setCustomRolesState('loading'); loadCustomRoles(); }}
                    >
                      {t('lmAdm.retry')}
                    </ActionButton>
                  }
                >
                  {t('lmAdm.users.customRolesErrorBody')}
                </Notice>
              )}

              {/* Banner de rol solo-lectura. roleCanWrite refleja ADMIN_ROLES
                  del server: admin / auditor / hr pueden escribir; el resto
                  (socio, soporte, invitado, y custom roles basados en ellos)
                  solo VEN. Sin esto el usuario marcaba todos los módulos y
                  creía haber dado permisos completos — Kevin 2026-06-24. */}
              {!formWrites && (
                <Notice
                  kind="pend"
                  title={t('lmAdm.users.readOnlyTitle', { role: ROLE_LABELS[formEffectiveRole] ?? form.role })}
                >
                  {t('lmAdm.users.readOnlyBody')}
                </Notice>
              )}

              <fieldset>
                <legend className="text-[12.5px] font-medium text-text-2">
                  {t('users.modules')}{' '}
                  <span className="font-normal tabular-nums text-text-3">
                    · {t('lmAdm.users.modulesCount', { n: String(checkedModules), total: String(ALL_MODULES.length) })}
                  </span>
                </legend>
                <p className="mt-1 flex items-center gap-1.5 text-[12px] text-text-3">
                  <Eye aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
                  {formWrites ? t('lmAdm.users.modulesHintWrite') : t('lmAdm.users.modulesHintRead')}
                </p>
                <div className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 rounded-ui-md border border-border p-3 min-[420px]:grid-cols-2 sm:grid-cols-3">
                  {ALL_MODULES.map((m) => (
                    <label key={m.key} className="flex min-w-0 cursor-pointer items-center gap-2 text-[13px] text-foreground [@media(pointer:coarse)]:min-h-10">
                      <input
                        type="checkbox"
                        checked={form.allowed_modules.includes(m.key)}
                        onChange={() => toggleModule(m.key)}
                        className="size-4 shrink-0 rounded-ui-sm border-control-border accent-primary"
                      />
                      <span className="min-w-0 truncate">{m.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {formError && <Notice kind="bad" title={formError} />}

              <div className="flex flex-wrap gap-2">
                <ActionButton type="submit" variant="primary" loading={saving}>
                  {saving ? t('common.saving') : (editingId ? t('users.save') : t('users.sendInvite'))}
                </ActionButton>
                <ActionButton onClick={closeForm}>
                  {t('common.cancel')}
                </ActionButton>
              </div>
            </form>
          </Panel>
        </div>
      )}

      {/* Users Table */}
      {activeTab === 'users' && (
        <>
          {listSuspect && (
            <Notice kind="pend" title={t('lmAdm.users.listUnknownTitle')}>
              {t('lmAdm.users.listUnknownBody')}
            </Notice>
          )}
          {/* Error de borrado: si el form está cerrado, el aviso va acá. */}
          {formError && !showForm && <Notice kind="bad" title={formError} />}
          <Panel
            title={t('users.registered')}
            hint={<span className="tabular-nums">{listSuspect ? '—' : users.length}</span>}
            flush
          >
            <FinTable
              columns={columns}
              rows={users}
              rowKey={(u) => u.id}
              caption={t('users.registered')}
              empty={listSuspect ? t('lmAdm.users.listUnknownCell') : undefined}
            />
          </Panel>
        </>
      )}

      {/* Reset Password Modal */}
      {resetPwUser && (
        <Dialog title={t('lmAdm.users.resetPw')} onClose={() => setResetPwUser(null)} closeLabel={t('common.close')}>
          {resetSuccess ? (
            <SuccessNote>{t('lmAdm.users.resetPwOk', { name: resetPwUser.name })}</SuccessNote>
          ) : (
            <form onSubmit={handleResetPassword} className="space-y-4">
              <p className="text-[13px] text-text-2">
                {t('lmAdm.users.resetPwFor', { name: resetPwUser.name, email: resetPwUser.email })}
              </p>
              <Field label={t('lmAdm.users.newPassword')} hint={t('lmAdm.users.minChars')} required>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={6}
                  autoComplete="new-password"
                  autoFocus
                />
              </Field>
              {resetPwError && (
                <Notice kind="bad" title={t('lmAdm.users.resetPwFailedTitle')}>
                  {t('lmAdm.users.resetPwFailedBody')}
                </Notice>
              )}
              <div className="flex justify-end gap-2">
                <ActionButton onClick={() => setResetPwUser(null)}>
                  {t('common.cancel')}
                </ActionButton>
                <ActionButton type="submit" variant="primary" loading={resetPwSaving}>
                  {t('common.save')}
                </ActionButton>
              </div>
            </form>
          )}
        </Dialog>
      )}

      {/* Reset 2FA confirmation modal */}
      {reset2faUser && (
        <Dialog title={t('lmAdm.users.reset2fa')} onClose={() => setReset2faUser(null)} closeLabel={t('common.close')}>
          <p className="text-[13px] text-text-2">
            {t('lmAdm.users.reset2faBody', { name: reset2faUser.name, email: reset2faUser.email })}
          </p>
          {reset2faError && <Notice kind="bad" title={reset2faError} />}
          <div className="flex justify-end gap-2">
            <ActionButton onClick={() => setReset2faUser(null)} disabled={reset2faLoading}>
              {t('common.cancel')}
            </ActionButton>
            <ActionButton variant="danger" onClick={() => void handleReset2fa()} loading={reset2faLoading}>
              {reset2faLoading ? t('lmAdm.users.reset2faLoading') : t('lmAdm.users.reset2fa')}
            </ActionButton>
          </div>
        </Dialog>
      )}
    </div>
  );
}
