'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  useAuth,
  hasModuleAccess,
  MODULE_LABELS,
  ROLE_LABELS,
} from '@/lib/auth-context';
import {
  Settings,
  Shield,
  Key,
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
  Loader2,
  Eye,
  EyeOff,
} from 'lucide-react';

type Tab = 'roles' | 'apis';

const ALL_MODULES = Object.keys(MODULE_LABELS);
const BASE_ROLES = ['admin', 'socio', 'auditor', 'soporte', 'hr', 'invitado'] as const;

interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  base_role: string;
  default_modules: string[];
  created_at: string;
  updated_at: string;
}

interface ApiCredential {
  provider: 'sendgrid' | 'coinsbuy' | 'unipayment' | 'fairpay';
  last_four: string | null;
  extra_config: Record<string, unknown> | null;
  is_configured: boolean;
  updated_at: string;
}

const PROVIDER_META: Record<ApiCredential['provider'], { label: string; description: string; extraFields: Array<{ key: string; label: string; placeholder?: string }> }> = {
  sendgrid: {
    label: 'SendGrid',
    description: 'Correos transaccionales (recuperación, notificaciones).',
    extraFields: [
      { key: 'from_email', label: 'From email', placeholder: 'dashboard@tu-dominio.com' },
      { key: 'from_name', label: 'From name', placeholder: 'Tu Empresa' },
    ],
  },
  coinsbuy: {
    label: 'Coinsbuy',
    description: 'Procesador de pagos crypto.',
    extraFields: [
      { key: 'merchant_id', label: 'Merchant ID' },
      { key: 'webhook_url', label: 'Webhook URL' },
    ],
  },
  unipayment: {
    label: 'Unipayment',
    description: 'Procesador de pagos.',
    extraFields: [
      { key: 'app_id', label: 'App ID' },
      { key: 'webhook_url', label: 'Webhook URL' },
    ],
  },
  fairpay: {
    label: 'Fairpay',
    description: 'Procesador de pagos.',
    extraFields: [
      { key: 'merchant_id', label: 'Merchant ID' },
      { key: 'webhook_url', label: 'Webhook URL' },
    ],
  },
};

export default function ConfiguracionesPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('roles');

  if (!hasModuleAccess(user, 'settings')) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">No tienes acceso a esta sección.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-slate-100 dark:bg-slate-900/50">
          <Settings className="w-5 h-5 text-slate-600 dark:text-slate-300" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Configuración</h1>
          <p className="text-sm text-muted-foreground">Roles personalizados e integraciones externas.</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        <TabButton active={tab === 'roles'} onClick={() => setTab('roles')} icon={Shield} label="Roles" />
        <TabButton active={tab === 'apis'} onClick={() => setTab('apis')} icon={Key} label="APIs externas" />
      </div>

      {tab === 'roles' ? <RolesSection /> : <ApisSection />}
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, label }: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
        active
          ? 'border-[var(--color-primary)] text-[var(--color-primary)]'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="w-4 h-4" />
      {label}
    </button>
  );
}

// ─── Roles tab ────────────────────────────────────────────────────────────

function RolesSection() {
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomRole | null>(null);
  const [showForm, setShowForm] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/custom-roles');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setRoles(data.roles);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando roles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este rol? Solo se puede borrar si nadie lo tiene asignado.')) return;
    try {
      const res = await fetch('/api/admin/custom-roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error');
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">Roles personalizados</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Define plantillas de rol con módulos predeterminados. Cada rol tiene un &quot;rol base&quot; que hereda capacidades (ver, editar, eliminar).
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setShowForm(true); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
        >
          <Plus className="w-4 h-4" /> Nuevo rol
        </button>
      </div>

      {showForm && (
        <RoleForm
          editing={editing}
          onClose={() => { setShowForm(false); setEditing(null); }}
          onSaved={() => { setShowForm(false); setEditing(null); reload(); }}
        />
      )}

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 text-sm">{error}</div>
      ) : roles.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          No hay roles personalizados. Los 6 roles del sistema siguen disponibles.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Nombre</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Rol base</th>
                <th className="text-left py-2 px-3 text-muted-foreground font-medium">Módulos</th>
                <th className="text-right py-2 px-3 text-muted-foreground font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.id} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="py-3 px-3">
                    <div className="font-medium">{r.name}</div>
                    {r.description && <div className="text-xs text-muted-foreground mt-0.5">{r.description}</div>}
                  </td>
                  <td className="py-3 px-3">
                    <Badge variant="neutral">{ROLE_LABELS[r.base_role] || r.base_role}</Badge>
                  </td>
                  <td className="py-3 px-3">
                    <div className="flex flex-wrap gap-1">
                      {r.default_modules.slice(0, 4).map((m) => (
                        <span key={m} className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          {MODULE_LABELS[m] || m}
                        </span>
                      ))}
                      {r.default_modules.length > 4 && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          +{r.default_modules.length - 4}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3 px-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => { setEditing(r); setShowForm(true); }}
                        className="p-1.5 rounded hover:bg-muted"
                        title="Editar"
                      >
                        <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
                      </button>
                      <button
                        onClick={() => handleDelete(r.id)}
                        className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950/50"
                        title="Eliminar"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-red-400" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RoleForm({ editing, onClose, onSaved }: {
  editing: CustomRole | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [baseRole, setBaseRole] = useState<string>(editing?.base_role ?? 'socio');
  const [modules, setModules] = useState<string[]>(editing?.default_modules ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleModule = (m: string) => {
    setModules((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/admin/custom-roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: editing ? 'update' : 'create',
          id: editing?.id,
          name,
          description,
          base_role: baseRole,
          default_modules: modules,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mb-4 bg-muted/30">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold">{editing ? 'Editar rol' : 'Nuevo rol'}</h3>
        <button onClick={onClose} className="p-1 hover:bg-muted rounded" aria-label="Cerrar">
          <X className="w-4 h-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1.5">Nombre</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="ej: Sales Lead"
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Rol base (capacidades)</label>
            <select
              value={baseRole}
              onChange={(e) => setBaseRole(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            >
              {BASE_ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r] || r}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              Determina si puede editar, agregar o eliminar.
            </p>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1.5">Descripción (opcional)</label>
          <input
            type="text"
            value={description ?? ''}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="ej: Líder de ventas, acceso a comisiones y reportes"
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Módulos permitidos por defecto</label>
          <div className="flex flex-wrap gap-2">
            {ALL_MODULES.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => toggleModule(m)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                  modules.includes(m)
                    ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                    : 'border-border hover:bg-muted'
                }`}
              >
                {MODULE_LABELS[m]}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {editing ? 'Guardar cambios' : 'Crear rol'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted"
          >
            Cancelar
          </button>
        </div>
      </form>
    </Card>
  );
}

// ─── APIs tab ─────────────────────────────────────────────────────────────

function ApisSection() {
  const [creds, setCreds] = useState<ApiCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiCredential['provider'] | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/api-credentials');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setCreds(data.credentials);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando credenciales');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const getCred = (provider: ApiCredential['provider']) =>
    creds.find((c) => c.provider === provider);

  const handleDelete = async (provider: ApiCredential['provider']) => {
    if (!confirm(`¿Eliminar las credenciales de ${PROVIDER_META[provider].label}?`)) return;
    try {
      const res = await fetch('/api/admin/api-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', provider }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error');
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 text-sm">
          {error}
        </div>
      )}

      {(Object.keys(PROVIDER_META) as Array<ApiCredential['provider']>).map((provider) => {
        const meta = PROVIDER_META[provider];
        const cred = getCred(provider);
        const isEditing = editing === provider;

        return (
          <Card key={provider}>
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-950/50">
                  <Key className="w-5 h-5 text-indigo-500" />
                </div>
                <div>
                  <h3 className="font-semibold">{meta.label}</h3>
                  <p className="text-xs text-muted-foreground">{meta.description}</p>
                </div>
              </div>
              {cred?.is_configured && !isEditing && (
                <Badge variant="success">
                  <Check className="w-3 h-3" /> Configurado
                </Badge>
              )}
            </div>

            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            ) : isEditing ? (
              <ApiCredentialForm
                provider={provider}
                existingExtras={cred?.extra_config || {}}
                onSaved={() => { setEditing(null); reload(); }}
                onCancel={() => setEditing(null)}
              />
            ) : cred?.is_configured ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">API key:</span>
                  <code className="px-2 py-0.5 rounded bg-muted font-mono">••••••••{cred.last_four}</code>
                </div>
                {cred.extra_config && Object.keys(cred.extra_config).length > 0 && (
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {Object.entries(cred.extra_config).map(([k, v]) => (
                      <div key={k}>
                        <span className="font-medium">{k}:</span> {String(v ?? '')}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Última actualización: {new Date(cred.updated_at).toLocaleString('es-ES')}
                </p>
                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => setEditing(provider)}
                    className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted"
                  >
                    Cambiar
                  </button>
                  <button
                    onClick={() => handleDelete(provider)}
                    className="px-3 py-1.5 rounded-lg border border-red-200 dark:border-red-800 text-red-600 text-sm hover:bg-red-50 dark:hover:bg-red-950/30"
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setEditing(provider)}
                className="px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
              >
                Configurar
              </button>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function ApiCredentialForm({ provider, existingExtras, onSaved, onCancel }: {
  provider: ApiCredential['provider'];
  existingExtras: Record<string, unknown>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const meta = PROVIDER_META[provider];
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [extras, setExtras] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of meta.extraFields) init[f.key] = String(existingExtras[f.key] ?? '');
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (secret.length < 8) {
      setError('La llave debe tener al menos 8 caracteres.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/admin/api-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          provider,
          secret,
          extra_config: extras,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error guardando');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3 mt-2 p-4 rounded-lg bg-muted/30 border border-border">
      <div>
        <label className="block text-sm font-medium mb-1.5">API Key / Secret</label>
        <div className="relative">
          <input
            type={showSecret ? 'text' : 'password'}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Pega aquí la llave. Se guardará encriptada."
            required
            autoComplete="new-password"
            className="w-full pr-11 px-3 py-2 rounded-lg border border-border bg-background text-sm font-mono"
          />
          <button
            type="button"
            onClick={() => setShowSecret((v) => !v)}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
            aria-label={showSecret ? 'Ocultar' : 'Mostrar'}
          >
            {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Por seguridad la llave no se muestra después de guardar. Si la cambias, pégala completa.
        </p>
      </div>

      {meta.extraFields.map((f) => (
        <div key={f.key}>
          <label className="block text-sm font-medium mb-1.5">{f.label}</label>
          <input
            type="text"
            value={extras[f.key] ?? ''}
            onChange={(e) => setExtras((prev) => ({ ...prev, [f.key]: e.target.value }))}
            placeholder={f.placeholder}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
          />
        </div>
      ))}

      {error && (
        <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 text-sm">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Guardar
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-muted"
        >
          Cancelar
        </button>
      </div>
    </form>
  );
}
