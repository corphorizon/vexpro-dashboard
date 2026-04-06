'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAuth, hasModuleAccess, ROLE_LABELS, ROLE_DESCRIPTIONS, ROLE_DEFAULT_MODULES, MODULE_LABELS, type User } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { Users, Plus, Pencil, Trash2, X } from 'lucide-react';

const ALL_MODULES = Object.keys(MODULE_LABELS);
const ALL_ROLES: Array<User['role']> = ['admin', 'socio', 'auditor', 'soporte', 'hr', 'invitado'];

interface UserForm {
  name: string;
  email: string;
  password: string;
  role: User['role'];
  allowed_modules: string[];
}

const emptyForm: UserForm = {
  name: '',
  email: '',
  password: '',
  role: 'socio',
  allowed_modules: ROLE_DEFAULT_MODULES['socio'],
};

export default function UsuariosPage() {
  const { t } = useI18n();
  const { user, users, createUser, updateUser, deleteUser } = useAuth();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  if (!hasModuleAccess(user, 'users')) {
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
      password: '',
      role: u.role,
      allowed_modules: [...u.allowed_modules],
    });
    setShowForm(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingId) {
      updateUser(editingId, {
        name: form.name,
        email: form.email,
        role: form.role,
        allowed_modules: form.allowed_modules,
      });
    } else {
      createUser(
        {
          name: form.name,
          email: form.email,
          role: form.role,
          company_id: user?.company_id || '',
          allowed_modules: form.allowed_modules,
          twofa_enabled: false,
          twofa_secret: null,
        },
        form.password
      );
    }
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  };

  const handleDelete = (id: string) => {
    deleteUser(id);
    setDeleteConfirm(null);
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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('users.title')}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t('users.subtitle')}</p>
        </div>
        <button
          onClick={handleCreate}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <Plus className="w-4 h-4" />
          {t('users.create')}
        </button>
      </div>

      {/* Form */}
      {showForm && (
        <Card>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">
              {editingId ? t('users.edit') : t('users.create')}
            </h2>
            <button onClick={() => { setShowForm(false); setEditingId(null); }} className="p-1 hover:bg-muted rounded" aria-label={t('common.cancel')}>
              <X className="w-4 h-4" />
            </button>
          </div>
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
              {!editingId && (
                <div>
                  <label className="block text-sm font-medium mb-1">{t('users.password')}</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm(prev => ({ ...prev, password: e.target.value }))}
                    required={!editingId}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                  />
                </div>
              )}
              <div>
                <label className="block text-sm font-medium mb-1">{t('users.role')}</label>
                <select
                  value={form.role}
                  onChange={(e) => {
                    const newRole = e.target.value as User['role'];
                    setForm(prev => ({ ...prev, role: newRole, allowed_modules: ROLE_DEFAULT_MODULES[newRole] || [] }));
                  }}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                >
                  {ALL_ROLES.map(role => (
                    <option key={role} value={role}>{ROLE_LABELS[role]}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground mt-1">{ROLE_DESCRIPTIONS[form.role]}</p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">{t('users.modules')}</label>
              <div className="flex flex-wrap gap-2">
                {ALL_MODULES.map(mod => (
                  <button
                    key={mod}
                    type="button"
                    onClick={() => toggleModule(mod)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                      form.allowed_modules.includes(mod)
                        ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                        : 'border-border hover:bg-muted'
                    }`}
                  >
                    {MODULE_LABELS[mod]}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 transition-opacity"
              >
                {editingId ? t('users.save') : t('users.create')}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setEditingId(null); }}
                className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted transition-colors"
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </Card>
      )}

      {/* Users Table */}
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
                  <td className="py-3 px-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleEdit(u)}
                        className="p-1.5 rounded hover:bg-muted transition-colors"
                        title={t('common.edit')}
                        aria-label={t('common.edit')}
                      >
                        <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                      </button>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
