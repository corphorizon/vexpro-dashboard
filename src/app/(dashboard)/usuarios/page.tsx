'use client';

import { useState, useEffect, useRef } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAuth, ROLE_LABELS, ROLE_DESCRIPTIONS, ROLE_DEFAULT_MODULES, MODULE_LABELS, type User } from '@/lib/auth-context';
import { useModuleAccess } from '@/lib/use-module-access';
import { RolesPanel } from '@/components/settings/roles-panel';
import { useI18n } from '@/lib/i18n';
import { withActiveCompany } from '@/lib/api-fetch';
// Shield icon removed with the Roles tab — keep ShieldOff for the 2FA badge.
import { Users, Plus, Pencil, Trash2, X, KeyRound, ShieldOff } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
// Single source of truth for the module catalog — same list and order the
// superadmin form uses, so /usuarios and /superadmin/users stay in sync.
import { ALL_MODULES } from '@/app/superadmin/companies/_form';

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

export default function UsuariosPage() {
  const { t } = useI18n();
  const { user, users, createUser, updateUser, deleteUser, resetPassword } = useAuth();
  const canAccess = useModuleAccess('users');
  // Two tabs inside /usuarios: the user list (default) and custom roles
  // (moved here from the old /configuraciones page).
  const [activeTab, setActiveTab] = useState<'users' | 'roles'>('users');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [resetPwUser, setResetPwUser] = useState<User | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetSuccess, setResetSuccess] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reset2faUser, setReset2faUser] = useState<User | null>(null);
  const [reset2faLoading, setReset2faLoading] = useState(false);
  const [reset2faError, setReset2faError] = useState<string | null>(null);
  const [customRoles, setCustomRoles] = useState<CustomRoleOption[]>([]);

  // Ref al Card del form de creación/edición. Cuando un admin hace click
  // en "Editar" desde una fila al fondo de la tabla, el form se monta
  // arriba de la lista — sin este scroll, el cambio era invisible y
  // parecía que el botón no hacía nada.
  const formCardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (showForm) {
      // requestAnimationFrame asegura que el Card ya esté en el DOM
      // (mountado por el conditional render) antes de scrollear.
      requestAnimationFrame(() => {
        formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }, [showForm]);

  useEffect(() => {
    // Fetch per-company custom roles — admin can assign them alongside built-ins.
    fetch(withActiveCompany('/api/admin/custom-roles'))
      .then(r => r.json())
      .then(data => { if (data.success) setCustomRoles(data.roles); })
      .catch(() => { /* non-fatal */ });
  }, []);

  if (!canAccess) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">{t('common.noAccess')}</p>
      </div>
    );
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
      setFormError(err instanceof Error ? err.message : 'Error al guardar usuario');
    } finally {
      setSaving(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPwUser || !newPassword) return;
    const ok = await resetPassword(resetPwUser.email, newPassword);
    if (ok) {
      setResetSuccess(true);
      setTimeout(() => {
        setResetPwUser(null);
        setNewPassword('');
        setResetSuccess(false);
      }, 2000);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteUser(id);
      setDeleteConfirm(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Error eliminando usuario');
      setDeleteConfirm(null);
    }
  };

  // Reenviar invitación: regenera el token y manda el correo de
  // nuevo. Solo aplica a usuarios con must_change_password=true (todavía
  // no activaron su cuenta) y que no son admin.
  const [resendingId, setResendingId] = useState<string | null>(null);

  const handleResendInvite = async (u: User) => {
    if (!confirm(`Reenviar invitación a ${u.email}?`)) return;
    setResendingId(u.id);
    try {
      const res = await fetch(withActiveCompany(`/api/admin/users/${u.id}/resend-invite`), {
        method: 'POST',
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        alert(json.error || 'Error reenviando invitación');
        return;
      }
      alert(`Invitación reenviada a ${u.email}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error de red');
    } finally {
      setResendingId(null);
    }
  };

  const handleReset2fa = async () => {
    if (!reset2faUser) return;
    setReset2faLoading(true);
    setReset2faError(null);
    try {
      const res = await fetch(withActiveCompany('/api/admin/reset-user-2fa'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: reset2faUser.id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Error reseteando 2FA');
      }
      // Reflect new state in the local list so the UI updates immediately
      updateUser(reset2faUser.id, { twofa_enabled: false });
      setReset2faUser(null);
    } catch (err) {
      setReset2faError(err instanceof Error ? err.message : 'Error reseteando 2FA');
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

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('users.title')}
        subtitle={t('users.subtitle')}
        icon={Users}
        actions={
          activeTab === 'users' ? (
            <button
              onClick={handleCreate}
              className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              {t('users.create')}
            </button>
          ) : undefined
        }
      />

      {/* Tabs — Usuarios + Roles
          NOTE: The Roles tab is temporarily HIDDEN because the backing
          logic is half-built: the custom_roles table and RolesPanel UI
          exist and can create/edit rows, but hasModuleAccess() in
          auth-context.tsx only recognises the 6 BUILT_IN_ROLES — custom
          roles don't grant module permissions yet. Re-enable this tab
          once the permission resolver wires up `effective_role`.
          Keeping the RolesPanel import and the setActiveTab('roles')
          branch below so nothing rots while the feature is paused.
          TODO: Custom roles UI — pendiente wirear con hasModuleAccess
          antes de activar. */}
      <div className="flex border-b border-border overflow-x-auto">
        <button
          onClick={() => setActiveTab('users')}
          className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'users'
              ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Users className="w-4 h-4" /> Usuarios
        </button>
      </div>

      {/* Roles tab body still wired for future re-enable — never shown today. */}
      {activeTab === 'roles' && <RolesPanel />}

      {/* Form — envuelto en div para anclar el ref de scroll-into-view
          (Card no expone forwardRef). */}
      {activeTab === 'users' && showForm && (
        <div ref={formCardRef}>
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">
              {editingId ? t('users.edit') : t('users.create')}
            </h2>
            <button onClick={() => { setShowForm(false); setEditingId(null); }} className="p-1 hover:bg-muted rounded" aria-label={t('common.cancel')}>
              <X className="w-4 h-4" />
            </button>
          </div>
          {!editingId && (
            <p className="text-xs text-muted-foreground mb-3">
              Al enviar la invitación, el usuario recibirá un correo con un link para crear su contraseña. El enlace expira en 24 horas.
            </p>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1">{t('users.name')}</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                  required
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">{t('users.email')}</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm(prev => ({ ...prev, email: e.target.value }))}
                  required
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                />
              </div>
              {/* Sin campo Contraseña — el flujo nuevo manda invitación
                  por email. El usuario crea su propia contraseña en
                  /reset-password?token=...&mode=setup tras click en el
                  link. Aviso al admin debajo del título del form. */}
              <div>
                <label className="block text-sm font-medium mb-1">{t('users.role')}</label>
                <select
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
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                >
                  <optgroup label="Roles del sistema">
                    {/* `admin` se excluye: solo el superadmin puede crear
                        usuarios con rol admin (vía /superadmin/users). El
                        endpoint /api/admin/create-user también lo bloquea
                        server-side con 403, esto es defensa en profundidad. */}
                    {ALL_ROLES.filter(role => role !== 'admin').map(role => (
                      <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                    ))}
                  </optgroup>
                  {customRoles.length > 0 && (
                    <optgroup label="Roles personalizados">
                      {customRoles.map(c => (
                        <option key={c.id} value={c.name}>{c.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <p className="text-xs text-muted-foreground mt-1">
                  {customRoles.find(c => c.name === form.role)?.description
                    ?? ROLE_DESCRIPTIONS[form.role]
                    ?? 'Rol personalizado — capacidades heredadas del rol base.'}
                </p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">{t('users.modules')}</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 rounded-lg border border-border">
                {ALL_MODULES.map((m) => (
                  <label key={m.key} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.allowed_modules.includes(m.key)}
                      onChange={() => toggleModule(m.key)}
                      className="rounded border-border"
                    />
                    <span>{m.label}</span>
                  </label>
                ))}
              </div>
            </div>

            {formError && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm">
                {formError}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {saving ? 'Guardando...' : (editingId ? t('users.save') : t('users.sendInvite'))}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setEditingId(null); setFormError(null); }}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </Card>
        </div>
      )}

      {/* Users Table */}
      {activeTab === 'users' && (
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-violet-50 dark:bg-violet-950/50">
            <Users className="w-5 h-5 text-violet-500" />
          </div>
          <h2 className="text-lg font-semibold">{t('users.registered')} ({users.length})</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('users.name')}</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('users.email')}</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('users.role')}</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('users.modules')}</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">2FA</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-border/50 hover:bg-muted/50">
                  <td className="py-3 px-3 font-medium">{u.name}</td>
                  <td className="py-3 px-3 text-muted-foreground">{u.email}</td>
                  <td className="py-3 px-3">
                    <Badge variant={u.role === 'admin' ? 'success' : 'neutral'}>
                      {ROLE_LABELS[u.role] || u.role}
                    </Badge>
                  </td>
                  <td className="py-3 px-3">
                    <div className="flex flex-wrap gap-1">
                      {u.allowed_modules.slice(0, 4).map(mod => (
                        <span key={mod} className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          {MODULE_LABELS[mod] || mod}
                        </span>
                      ))}
                      {u.allowed_modules.length > 4 && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          +{u.allowed_modules.length - 4}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-3">
                    <span className={u.twofa_enabled
                      ? 'inline-flex px-2 py-0.5 rounded-full text-[10px] bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300'
                      : 'inline-flex px-2 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'
                    }>
                      {u.twofa_enabled ? 'Activo' : 'No activo'}
                    </span>
                  </td>
                  <td className="py-3 px-3 text-right">
                    {/* Para usuarios con role='admin', el admin de empresa
                        no puede gestionarlos — solo el superadmin. Mostramos
                        un guion en vez de los botones. */}
                    {u.role === 'admin' ? (
                      <span className="text-xs text-muted-foreground" title="Solo el superadmin gestiona admins">—</span>
                    ) : (
                    <div className="flex items-center justify-end gap-1">
                      {/* Reenviar invitación: solo si todavía no creó su contraseña. */}
                      {u.must_change_password && (
                        <button
                          onClick={() => handleResendInvite(u)}
                          disabled={resendingId === u.id}
                          className="px-2 py-1 text-[11px] rounded border border-blue-300 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50"
                          title={t('users.resendInvite')}
                          aria-label={t('users.resendInvite')}
                        >
                          {resendingId === u.id ? '…' : 'Reenviar'}
                        </button>
                      )}
                      <button
                        onClick={() => handleEdit(u)}
                        className="p-1.5 rounded hover:bg-muted transition-colors"
                        title={t('common.edit')}
                        aria-label={t('common.edit')}
                      >
                        <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                      </button>
                      <button
                        onClick={() => { setResetPwUser(u); setNewPassword(''); setResetSuccess(false); }}
                        className="p-1.5 rounded hover:bg-amber-50 dark:hover:bg-amber-950/50 transition-colors"
                        title="Resetear contraseña"
                        aria-label="Resetear contraseña"
                      >
                        <KeyRound className="w-3.5 h-3.5 text-amber-500" />
                      </button>
                      {u.twofa_enabled && (
                        <button
                          onClick={() => { setReset2faUser(u); setReset2faError(null); }}
                          className="p-1.5 rounded hover:bg-indigo-50 dark:hover:bg-indigo-950/50 transition-colors"
                          title="Resetear 2FA"
                          aria-label="Resetear 2FA"
                        >
                          <ShieldOff className="w-3.5 h-3.5 text-indigo-500" />
                        </button>
                      )}
                      {u.id !== user?.id && (
                        deleteConfirm === u.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleDelete(u.id)}
                              className="px-2 py-1 text-xs rounded bg-red-500 text-white hover:bg-red-600"
                            >
                              {t('users.confirm')}
                            </button>
                            <button
                              onClick={() => setDeleteConfirm(null)}
                              className="px-2 py-1 text-xs rounded border border-border hover:bg-muted"
                            >
                              {t('common.cancel')}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirm(u.id)}
                            className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950/50 transition-colors"
                            title={t('common.delete')}
                            aria-label={t('common.delete')}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-red-400" />
                          </button>
                        )
                      )}
                    </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      )}

      {/* Reset Password Modal */}
      {resetPwUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-xl p-6 shadow-lg w-full max-w-sm mx-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Resetear Contraseña</h2>
              <button onClick={() => setResetPwUser(null)} className="p-1 hover:bg-muted rounded">
                <X className="w-4 h-4" />
              </button>
            </div>
            {resetSuccess ? (
              <div className="px-4 py-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 text-sm">
                Contraseña actualizada correctamente para {resetPwUser.name}.
              </div>
            ) : (
              <form onSubmit={handleResetPassword} className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Nueva contraseña para <span className="font-medium text-foreground">{resetPwUser.name}</span> ({resetPwUser.email})
                </p>
                <div>
                  <label className="block text-sm font-medium mb-1">Nueva contraseña</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    minLength={6}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                    placeholder="Mínimo 6 caracteres"
                    autoFocus
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="flex-1 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
                  >
                    Guardar
                  </button>
                  <button
                    type="button"
                    onClick={() => setResetPwUser(null)}
                    className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Reset 2FA confirmation modal */}
      {reset2faUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-xl p-6 shadow-lg w-full max-w-sm mx-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Resetear 2FA</h2>
              <button onClick={() => setReset2faUser(null)} className="p-1 hover:bg-muted rounded" aria-label="Cerrar">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Se desactivará la autenticación de dos factores para{' '}
              <span className="font-medium text-foreground">{reset2faUser.name}</span> ({reset2faUser.email}).
              El usuario deberá volver a configurar su aplicación de autenticación.
            </p>
            {reset2faError && (
              <div className="px-3 py-2 mb-4 rounded-lg bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
                {reset2faError}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleReset2fa}
                disabled={reset2faLoading}
                className="flex-1 px-4 py-2 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors disabled:opacity-50"
              >
                {reset2faLoading ? 'Reseteando…' : 'Resetear 2FA'}
              </button>
              <button
                onClick={() => setReset2faUser(null)}
                disabled={reset2faLoading}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
