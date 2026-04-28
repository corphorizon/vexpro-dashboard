'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Search, Plus, Edit2, Trash2, ChevronUp, ChevronDown,
  History, Settings, Upload, CheckCircle2, AlertCircle, AlertTriangle, X,
} from 'lucide-react';
import type {
  IbRebateConfig, IbRebateThresholds, AlertResult, IbRebateHistoryEntry,
} from '@/lib/ib-rebates/types';
import { DEFAULT_THRESHOLDS } from '@/lib/ib-rebates/types';
import { computeAlert } from '@/lib/ib-rebates/alerts';
import { withActiveCompany } from '@/lib/api-fetch';

// ─── Tipos locales ────────────────────────────────────────────────────────

type FormShape = {
  username: string;
  archivo: string;
  config_date: string;
  stp: number;
  ecn: number;
  cent: number;
  pro: number;
  vip: number;
  elite: number;
  syntheticos_level: number;
  propfirm_level: number;
  notes: string;
};

const EMPTY_FORM: FormShape = {
  username: '',
  archivo: '',
  config_date: new Date().toISOString().slice(0, 10),
  stp: 0, ecn: 0, cent: 0, pro: 0, vip: 0, elite: 0,
  syntheticos_level: 0, propfirm_level: 0,
  notes: '',
};

type FilterAlert = 'all' | 'green' | 'yellow' | 'orange' | 'red' | 'goals_met';
type ChangeIntent = 'edit' | 'upgrade' | 'downgrade';

// ─── Componente principal ─────────────────────────────────────────────────

export function IbRebatesTab() {
  const [configs, setConfigs] = useState<IbRebateConfig[]>([]);
  const [thresholds, setThresholds] = useState<IbRebateThresholds>({
    company_id: '',
    ...DEFAULT_THRESHOLDS,
  });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterAlert, setFilterAlert] = useState<FilterAlert>('all');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingIntent, setPendingIntent] = useState<ChangeIntent>('edit');
  const [form, setForm] = useState<FormShape>(EMPTY_FORM);
  const [showThresholds, setShowThresholds] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showHistoryFor, setShowHistoryFor] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<IbRebateHistoryEntry[]>([]);

  // ─── Carga inicial: configs + thresholds en paralelo ────────────────────
  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [cRes, tRes] = await Promise.all([
        fetch(withActiveCompany('/api/admin/ib-rebates')),
        fetch(withActiveCompany('/api/admin/ib-rebates/thresholds')),
      ]);
      const cData = await cRes.json();
      const tData = await tRes.json();
      if (cData.success) setConfigs(cData.configs);
      if (tData.success) setThresholds(tData.thresholds);
    } catch (err) {
      console.error('[ib-rebates] load error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ─── Filtrado en memoria ────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return configs.filter((c) => {
      if (search && !c.username.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterAlert === 'all') return true;
      if (filterAlert === 'goals_met') return c.goals_met;
      const alert = computeAlert(c, thresholds);
      return alert.level === filterAlert;
    });
  }, [configs, search, filterAlert, thresholds]);

  // ─── Form: crear / editar / upgrade / downgrade ─────────────────────────

  const openCreate = () => {
    setEditingId(null);
    setPendingIntent('edit'); // ignorado en POST, importa en PATCH
    setForm(EMPTY_FORM);
    setShowForm(true);
  };

  const openEdit = (c: IbRebateConfig, intent: ChangeIntent = 'edit') => {
    setEditingId(c.id);
    setPendingIntent(intent);
    setForm({
      username: c.username,
      archivo: c.archivo || '',
      config_date: c.config_date,
      stp: c.stp, ecn: c.ecn, cent: c.cent,
      pro: c.pro, vip: c.vip, elite: c.elite,
      syntheticos_level: c.syntheticos_level,
      propfirm_level: c.propfirm_level,
      notes: c.notes || '',
    });
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setPendingIntent('edit');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingId) {
        const res = await fetch(withActiveCompany(`/api/admin/ib-rebates/${editingId}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...form, changeType: pendingIntent }),
        });
        const data = await res.json();
        if (!data.success) { alert(data.error || 'Error al guardar'); return; }
      } else {
        const res = await fetch(withActiveCompany('/api/admin/ib-rebates'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
        const data = await res.json();
        if (!data.success) { alert(data.error || 'Error al crear'); return; }
      }
      closeForm();
      loadAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error');
    }
  };

  // ─── Acciones por fila ──────────────────────────────────────────────────

  const handleToggleGoals = async (c: IbRebateConfig) => {
    const msg = c.goals_met
      ? `¿Quitar marca de "cumplió metas" a ${c.username}?`
      : `¿Marcar que ${c.username} cumplió metas?`;
    if (!confirm(msg)) return;
    try {
      const res = await fetch(withActiveCompany(`/api/admin/ib-rebates/${c.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changeType: 'goals_met' }),
      });
      const data = await res.json();
      if (!data.success) { alert(data.error); return; }
      loadAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error');
    }
  };

  const handleDelete = async (c: IbRebateConfig) => {
    if (!confirm(`¿Eliminar configuración de ${c.username}? Esta acción no se puede deshacer.`)) return;
    try {
      const res = await fetch(withActiveCompany(`/api/admin/ib-rebates/${c.id}`), {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!data.success) { alert(data.error); return; }
      loadAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error');
    }
  };

  const handleViewHistory = async (configId: string) => {
    setShowHistoryFor(configId);
    setHistoryEntries([]);
    try {
      const res = await fetch(withActiveCompany(`/api/admin/ib-rebates/${configId}/history`));
      const data = await res.json();
      if (data.success) setHistoryEntries(data.history);
    } catch (err) {
      console.error('[ib-rebates] history error:', err);
    }
  };

  // ─── Render helpers ─────────────────────────────────────────────────────

  const renderAlertBadge = (alert: AlertResult) => {
    const colors: Record<string, string> = {
      green: 'bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/30 dark:text-emerald-300',
      yellow: 'bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-900/30 dark:text-yellow-300',
      orange: 'bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-900/30 dark:text-orange-300',
      red: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-300',
    };
    const Icon = alert.level === 'green' ? CheckCircle2
               : alert.level === 'red' ? AlertCircle
               : AlertTriangle;
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${colors[alert.level]}`}>
        <Icon className="w-3.5 h-3.5" />
        {alert.message} ({alert.daysSince}d)
      </span>
    );
  };

  const renderChangeTypeBadge = (type: IbRebateConfig['last_change_type']) => {
    if (type === 'upgrade') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-100 text-blue-800 border border-blue-300 dark:bg-blue-900/30 dark:text-blue-300">
          <ChevronUp className="w-3 h-3" />Upgraded
        </span>
      );
    }
    if (type === 'downgrade') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-100 text-purple-800 border border-purple-300 dark:bg-purple-900/30 dark:text-purple-300">
          <ChevronDown className="w-3 h-3" />Downgraded
        </span>
      );
    }
    return null;
  };

  if (loading) {
    return <div className="p-8 text-center text-muted-foreground">Cargando configuraciones...</div>;
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* Header con búsqueda + filtros + acciones */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder="Buscar por username..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-card text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
          />
        </div>
        <select
          value={filterAlert}
          onChange={(e) => setFilterAlert(e.target.value as FilterAlert)}
          className="px-3 py-2 rounded-lg border border-border bg-card text-sm"
        >
          <option value="all">Todos los estados</option>
          <option value="green">🟢 OK</option>
          <option value="yellow">🟡 Alerta</option>
          <option value="orange">🟠 Naranja</option>
          <option value="red">🔴 Pendiente revisar</option>
          <option value="goals_met">🟦 Cumplió metas</option>
        </select>
        <button
          onClick={() => setShowImport(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-card text-sm hover:bg-muted"
        >
          <Upload className="w-4 h-4" /> Importar Excel
        </button>
        <button
          onClick={() => setShowThresholds(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-card text-sm hover:bg-muted"
        >
          <Settings className="w-4 h-4" /> Umbrales
        </button>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
        >
          <Plus className="w-4 h-4" /> Nueva configuración
        </button>
      </div>

      {/* Tabla */}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm min-w-[1100px]">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="text-left p-3 font-medium">Username</th>
              <th className="text-left p-3 font-medium">Fecha original</th>
              <th className="text-left p-3 font-medium">Última actualización</th>
              <th className="text-center p-3 font-medium">STP</th>
              <th className="text-center p-3 font-medium">ECN</th>
              <th className="text-center p-3 font-medium">CENT</th>
              <th className="text-center p-3 font-medium">PRO</th>
              <th className="text-center p-3 font-medium">VIP</th>
              <th className="text-center p-3 font-medium">ELITE</th>
              <th className="text-center p-3 font-medium">Sint.</th>
              <th className="text-center p-3 font-medium">PropFirm</th>
              <th className="text-left p-3 font-medium">Estado</th>
              <th className="text-right p-3 font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={13} className="p-8 text-center text-muted-foreground">
                  No hay configuraciones
                </td>
              </tr>
            ) : filtered.map((c) => {
              const alert = computeAlert(c, thresholds);
              return (
                <tr key={c.id} className="border-t border-border hover:bg-muted/30">
                  <td className="p-3 font-medium">{c.username}</td>
                  <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(c.original_config_date).toLocaleDateString()}
                  </td>
                  <td className="p-3 text-xs whitespace-nowrap">
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {new Date(c.last_update_date).toLocaleDateString()}
                      </span>
                      {c.last_update_date !== c.original_config_date && (
                        <span className="text-[10px] text-muted-foreground">(modificada)</span>
                      )}
                    </div>
                  </td>
                  <td className="p-3 text-center">{c.stp}</td>
                  <td className="p-3 text-center">{c.ecn}</td>
                  <td className="p-3 text-center">{c.cent}</td>
                  <td className="p-3 text-center">{c.pro}</td>
                  <td className="p-3 text-center">{c.vip}</td>
                  <td className="p-3 text-center">{c.elite}</td>
                  <td className="p-3 text-center">{c.syntheticos_level}</td>
                  <td className="p-3 text-center">{c.propfirm_level}</td>
                  <td className="p-3">
                    <div className="flex flex-col gap-1 items-start">
                      {renderAlertBadge(alert)}
                      {renderChangeTypeBadge(c.last_change_type)}
                      {c.goals_met && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-sky-100 text-sky-800 border border-sky-300 dark:bg-sky-900/30 dark:text-sky-300">
                          <CheckCircle2 className="w-3 h-3" /> Cumplió metas
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        onClick={() => openEdit(c, 'edit')}
                        title="Editar"
                        className="p-1.5 rounded hover:bg-muted"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => openEdit(c, 'upgrade')}
                        title="Upgrade (subir niveles)"
                        className="p-1.5 rounded hover:bg-blue-50 dark:hover:bg-blue-950/40 text-blue-600"
                      >
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => openEdit(c, 'downgrade')}
                        title="Downgrade (bajar niveles)"
                        className="p-1.5 rounded hover:bg-purple-50 dark:hover:bg-purple-950/40 text-purple-600"
                      >
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleToggleGoals(c)}
                        title={c.goals_met ? 'Quitar metas' : 'Marcar metas cumplidas'}
                        className="p-1.5 rounded hover:bg-muted"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleViewHistory(c.id)}
                        title="Ver historial"
                        className="p-1.5 rounded hover:bg-muted"
                      >
                        <History className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(c)}
                        title="Eliminar"
                        className="p-1.5 rounded hover:bg-red-50 text-red-600 dark:hover:bg-red-950/40"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showForm && (
        <FormModal
          form={form}
          setForm={setForm}
          editingId={editingId}
          intent={pendingIntent}
          onClose={closeForm}
          onSubmit={handleSubmit}
        />
      )}

      {showThresholds && (
        <ThresholdsModal
          thresholds={thresholds}
          onClose={() => setShowThresholds(false)}
          onSaved={() => { setShowThresholds(false); loadAll(); }}
        />
      )}

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); loadAll(); }}
        />
      )}

      {showHistoryFor && (
        <HistoryModal
          entries={historyEntries}
          onClose={() => { setShowHistoryFor(null); setHistoryEntries([]); }}
        />
      )}
    </div>
  );
}

// ─── Sub-componentes (modales) ────────────────────────────────────────────

function FormModal({
  form, setForm, editingId, intent, onClose, onSubmit,
}: {
  form: FormShape;
  setForm: React.Dispatch<React.SetStateAction<FormShape>>;
  editingId: string | null;
  intent: ChangeIntent;
  onClose: () => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const titleByIntent: Record<ChangeIntent, string> = {
    edit: 'Editar configuración',
    upgrade: 'Upgrade — subir niveles',
    downgrade: 'Downgrade — bajar niveles',
  };
  const heading = !editingId ? 'Nueva configuración' : titleByIntent[intent];

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <form
        onSubmit={onSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-card rounded-xl shadow-xl p-6 max-w-2xl w-full space-y-3 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">{heading}</h3>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted" aria-label="Cerrar">
            <X className="w-4 h-4" />
          </button>
        </div>
        {editingId && (
          <p className="text-xs text-muted-foreground">
            Al guardar, la fecha se reinicia a hoy y se registra como{' '}
            <strong>{intent}</strong> en el historial.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium block mb-1">Username</span>
            <input
              required
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium block mb-1">Archivo (referencia)</span>
            <input
              value={form.archivo}
              onChange={(e) => setForm({ ...form, archivo: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium block mb-1">
              {editingId ? 'Fecha (no se modifica al editar)' : 'Fecha de configuración'}
            </span>
            <input
              type="date"
              required
              disabled={!!editingId}
              value={form.config_date}
              onChange={(e) => setForm({ ...form, config_date: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            />
            {editingId && (
              <p className="text-[10px] text-muted-foreground mt-1">
                Al guardar, &quot;Última actualización&quot; pasa a hoy. La fecha original queda intacta.
              </p>
            )}
          </label>
          <div />
          {(['stp', 'ecn', 'cent', 'pro', 'vip', 'elite'] as const).map((k) => (
            <label key={k} className="block">
              <span className="text-xs font-medium block mb-1 uppercase">{k}</span>
              <input
                type="number"
                step="0.01"
                value={form[k]}
                onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              />
            </label>
          ))}
          <label className="block">
            <span className="text-xs font-medium block mb-1">Sintéticos (Nivel)</span>
            <input
              type="number"
              value={form.syntheticos_level}
              onChange={(e) => setForm({ ...form, syntheticos_level: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium block mb-1">PropFirm (Nivel)</span>
            <input
              type="number"
              value={form.propfirm_level}
              onChange={(e) => setForm({ ...form, propfirm_level: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block col-span-2">
            <span className="text-xs font-medium block mb-1">Notas (opcional)</span>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted"
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
          >
            {editingId ? 'Guardar' : 'Crear'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ThresholdsModal({
  thresholds, onClose, onSaved,
}: {
  thresholds: IbRebateThresholds;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    initial_yellow_days: thresholds.initial_yellow_days,
    initial_red_days: thresholds.initial_red_days,
    recurring_yellow_days: thresholds.recurring_yellow_days,
    recurring_orange_days: thresholds.recurring_orange_days,
    recurring_red_days: thresholds.recurring_red_days,
  });
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(withActiveCompany('/api/admin/ib-rebates/thresholds'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!data.success) { alert(data.error); return; }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="bg-card rounded-xl shadow-xl p-6 max-w-md w-full space-y-3"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Umbrales de alerta</h3>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted" aria-label="Cerrar">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          Ajusta los días para cada nivel de alerta.
        </p>
        <div className="space-y-3">
          <p className="text-sm font-medium">Modo inicial (configs nuevas o solo editadas)</p>
          <label className="block">
            <span className="text-xs">Días para 🟡 amarillo (alertar net deposit)</span>
            <input
              type="number"
              value={form.initial_yellow_days}
              onChange={(e) => setForm({ ...form, initial_yellow_days: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs">Días para 🔴 rojo (pendiente revisar)</span>
            <input
              type="number"
              value={form.initial_red_days}
              onChange={(e) => setForm({ ...form, initial_red_days: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <p className="text-sm font-medium pt-2">Modo recurrente (después de upgrade/downgrade)</p>
          <label className="block">
            <span className="text-xs">Días para 🟡 amarillo</span>
            <input
              type="number"
              value={form.recurring_yellow_days}
              onChange={(e) => setForm({ ...form, recurring_yellow_days: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs">Días para 🟠 naranja</span>
            <input
              type="number"
              value={form.recurring_orange_days}
              onChange={(e) => setForm({ ...form, recurring_orange_days: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs">Días para 🔴 rojo</span>
            <input
              type="number"
              value={form.recurring_red_days}
              onChange={(e) => setForm({ ...form, recurring_red_days: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Guardando...' : 'Guardar'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ImportModal({
  onClose, onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'skip' | 'update'>('skip');
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{
    inserted: number; updated: number; skipped: number;
    errors: string[]; total: number;
  } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('mode', mode);
      const res = await fetch(withActiveCompany('/api/admin/ib-rebates/import'), {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!data.success) { alert(data.error); return; }
      setResult(data);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-card rounded-xl shadow-xl p-6 max-w-md w-full space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Importar Excel masivo</h3>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted" aria-label="Cerrar">
            <X className="w-4 h-4" />
          </button>
        </div>
        {result ? (
          <div className="space-y-2 text-sm">
            <p>Total filas leídas: <strong>{result.total}</strong></p>
            <p>Insertadas: <strong className="text-emerald-600">{result.inserted}</strong></p>
            <p>Actualizadas: <strong className="text-blue-600">{result.updated}</strong></p>
            <p>Omitidas (duplicados): <strong className="text-yellow-600">{result.skipped}</strong></p>
            {result.errors.length > 0 && (
              <div className="rounded p-2 bg-red-50 border border-red-200 text-xs max-h-32 overflow-y-auto dark:bg-red-950/40 dark:border-red-900">
                <p className="font-medium text-red-800 dark:text-red-300 mb-1">Errores:</p>
                {result.errors.map((er, i) => <p key={i}>{er}</p>)}
              </div>
            )}
            <button
              onClick={onImported}
              className="w-full mt-3 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
            >
              Cerrar
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Columnas esperadas: Archivo | Fecha | Username | STP | ECN | CENT | PRO | VIP | ELITE | Sintéticos | PropFirm.
            </p>
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              required
              className="w-full text-sm"
            />
            <label className="block">
              <span className="text-xs font-medium block mb-1">Si username ya existe</span>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'skip' | 'update')}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              >
                <option value="skip">Omitir (no tocar)</option>
                <option value="update">Actualizar con datos del Excel</option>
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={uploading || !file}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {uploading ? 'Importando...' : 'Importar'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function HistoryModal({
  entries, onClose,
}: {
  entries: IbRebateHistoryEntry[];
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-card rounded-xl shadow-xl p-6 max-w-2xl w-full space-y-3 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Historial de cambios</h3>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted" aria-label="Cerrar">
            <X className="w-4 h-4" />
          </button>
        </div>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No hay historial</p>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div key={e.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex justify-between mb-1">
                  <span className="font-medium capitalize">{e.change_type}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(e.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Por: {e.changed_by_name || 'Desconocido'}
                </p>
                {e.notes && <p className="text-xs mt-1">{e.notes}</p>}
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
