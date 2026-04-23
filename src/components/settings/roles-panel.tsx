'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { MODULE_LABELS, ROLE_LABELS, BUILT_IN_ROLES } from '@/lib/auth-context';
import { withActiveCompany } from '@/lib/api-fetch';
import { Plus, Pencil, Trash2, X, Loader2 } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// RolesPanel — custom roles management for a single company.
//
// Extracted from the old /configuraciones page so it can be embedded inside
// /usuarios as a tab. The API endpoint `/api/admin/custom-roles` is already
// scoped to the caller's company via verifyAdminAuth — no prop needed.
// ─────────────────────────────────────────────────────────────────────────────

const ALL_MODULES = Object.keys(MODULE_LABELS);
// Alias to the single built-in roles list — kept as BASE_ROLES locally for
// readability within this file (custom roles extend a "base" built-in role).
const BASE_ROLES = BUILT_IN_ROLES;

interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  base_role: string;
  default_modules: string[];
  created_at: string;
  updated_at: string;
}

export function RolesPanel() {
  const [roles, setRoles] = useState<CustomRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CustomRole | null>(null);
  const [showForm, setShowForm] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(withActiveCompany('/api/admin/custom-roles'));
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
      const res = await fetch(withActiveCompany('/api/admin/custom-roles'), {
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
      const res = await fetch(withActiveCompany('/api/admin/custom-roles'), {
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
