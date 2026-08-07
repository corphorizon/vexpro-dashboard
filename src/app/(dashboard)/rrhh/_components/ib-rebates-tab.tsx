'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Search, Plus, Edit2, Trash2, ChevronUp, ChevronDown,
  History, Settings, Upload, CheckCircle2, AlertCircle, AlertTriangle, X,
} from 'lucide-react';
import type {
  IbRebateConfig, IbRebateThresholds, AlertResult, IbRebateHistoryEntry,
} from '@/lib/ib-rebates/types';
import { DEFAULT_THRESHOLDS } from '@/lib/ib-rebates/types';
import { computeAlert } from '@/lib/ib-rebates/alerts';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';

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
  const { t } = useI18n();
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
        apiFetch('/api/admin/ib-rebates'),
        apiFetch('/api/admin/ib-rebates/thresholds'),
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
        const res = await apiFetch(`/api/admin/ib-rebates/${editingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...form, changeType: pendingIntent }),
        });
        const data = await res.json();
        if (!data.success) { alert(data.error || t('ibRebates.errorSave')); return; }
      } else {
        const res = await apiFetch('/api/admin/ib-rebates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
        const data = await res.json();
        if (!data.success) { alert(data.error || t('ibRebates.errorCreate')); return; }
      }
      closeForm();
      loadAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : t('ibRebates.errorGeneric'));
    }
  };

  // ─── Acciones por fila ──────────────────────────────────────────────────

  const handleToggleGoals = async (c: IbRebateConfig) => {
    const msg = c.goals_met
      ? t('ibRebates.confirmUnsetGoals', { username: c.username })
      : t('ibRebates.confirmSetGoals', { username: c.username });
    if (!confirm(msg)) return;
    try {
      const res = await apiFetch(`/api/admin/ib-rebates/${c.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changeType: 'goals_met' }),
      });
      const data = await res.json();
      if (!data.success) { alert(data.error); return; }
      loadAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : t('ibRebates.errorGeneric'));
    }
  };

  const handleDelete = async (c: IbRebateConfig) => {
    if (!confirm(t('ibRebates.confirmDelete', { username: c.username }))) return;
    try {
      const res = await apiFetch(`/api/admin/ib-rebates/${c.id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!data.success) { alert(data.error); return; }
      loadAll();
    } catch (err) {
      alert(err instanceof Error ? err.message : t('ibRebates.errorGeneric'));
    }
  };

  const handleViewHistory = async (configId: string) => {
    setShowHistoryFor(configId);
    setHistoryEntries([]);
    try {
      const res = await apiFetch(`/api/admin/ib-rebates/${configId}/history`);
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
        {t(`ibRebates.alert.${alert.mode}.${alert.level}`)} ({t('ibRebates.daysShort', { days: String(alert.daysSince) })})
      </span>
    );
  };

  const renderChangeTypeBadge = (type: IbRebateConfig['last_change_type']) => {
    if (type === 'upgrade') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-100 text-blue-800 border border-blue-300 dark:bg-blue-900/30 dark:text-blue-300">
          <ChevronUp className="w-3 h-3" />{t('ibRebates.badgeUpgraded')}
        </span>
      );
    }
    if (type === 'downgrade') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-100 text-purple-800 border border-purple-300 dark:bg-purple-900/30 dark:text-purple-300">
          <ChevronDown className="w-3 h-3" />{t('ibRebates.badgeDowngraded')}
        </span>
      );
    }
    return null;
  };

  if (loading) {
    return <div className="p-8 text-center text-muted-foreground">{t('ibRebates.loading')}</div>;
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
            placeholder={t('ibRebates.searchPlaceholder')}
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
          <option value="all">{t('ibRebates.filterAll')}</option>
          <option value="green">{t('ibRebates.filterGreen')}</option>
          <option value="yellow">{t('ibRebates.filterYellow')}</option>
          <option value="orange">{t('ibRebates.filterOrange')}</option>
          <option value="red">{t('ibRebates.filterRed')}</option>
          <option value="goals_met">{t('ibRebates.filterGoalsMet')}</option>
        </select>
        <button
          onClick={() => setShowImport(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-card text-sm hover:bg-muted"
        >
          <Upload className="w-4 h-4" /> {t('ibRebates.importExcel')}
        </button>
        <button
          onClick={() => setShowThresholds(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border bg-card text-sm hover:bg-muted"
        >
          <Settings className="w-4 h-4" /> {t('ibRebates.thresholds')}
        </button>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
        >
          <Plus className="w-4 h-4" /> {t('ibRebates.newConfig')}
        </button>
      </div>

      {/* Tabla */}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        <table className="w-full text-sm min-w-[1100px]">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr className="border-b border-border">
              <th className="text-left py-2.5 px-3 font-medium">{t('ibRebates.colUsername')}</th>
              <th className="text-left py-2.5 px-3 font-medium">{t('ibRebates.colOriginalDate')}</th>
              <th className="text-left py-2.5 px-3 font-medium">{t('ibRebates.colLastUpdate')}</th>
              <th className="text-center py-2.5 px-3 font-medium">STP</th>
              <th className="text-center py-2.5 px-3 font-medium">ECN</th>
              <th className="text-center py-2.5 px-3 font-medium">CENT</th>
              <th className="text-center py-2.5 px-3 font-medium">PRO</th>
              <th className="text-center py-2.5 px-3 font-medium">VIP</th>
              <th className="text-center py-2.5 px-3 font-medium">ELITE</th>
              <th className="text-center py-2.5 px-3 font-medium">{t('ibRebates.colSynthetic')}</th>
              <th className="text-center py-2.5 px-3 font-medium">PropFirm</th>
              <th className="text-left py-2.5 px-3 font-medium">{t('common.status')}</th>
              <th className="text-right py-2.5 px-3 font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={13}>
                  <EmptyState
                    compact
                    title={t('ibRebates.emptyTitle')}
                    description={t('ibRebates.emptyDesc')}
                  />
                </td>
              </tr>
            ) : filtered.map((c) => {
              const alert = computeAlert(c, thresholds);
              return (
                <tr key={c.id} className="border-b border-border/50 hover:bg-muted/50 transition-colors">
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
                        <span className="text-[10px] text-muted-foreground">{t('ibRebates.modified')}</span>
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
                          <CheckCircle2 className="w-3 h-3" /> {t('ibRebates.goalsMet')}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        onClick={() => openEdit(c, 'edit')}
                        title={t('common.edit')}
                        className="p-1.5 rounded hover:bg-muted"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => openEdit(c, 'upgrade')}
                        title={t('ibRebates.upgradeTitle')}
                        className="p-1.5 rounded hover:bg-blue-50 dark:hover:bg-blue-950/40 text-blue-600"
                      >
                        <ChevronUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => openEdit(c, 'downgrade')}
                        title={t('ibRebates.downgradeTitle')}
                        className="p-1.5 rounded hover:bg-purple-50 dark:hover:bg-purple-950/40 text-purple-600"
                      >
                        <ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleToggleGoals(c)}
                        title={c.goals_met ? t('ibRebates.unsetGoals') : t('ibRebates.setGoals')}
                        className="p-1.5 rounded hover:bg-muted"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleViewHistory(c.id)}
                        title={t('ibRebates.viewHistory')}
                        className="p-1.5 rounded hover:bg-muted"
                      >
                        <History className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(c)}
                        title={t('common.delete')}
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
  const { t } = useI18n();
  const titleByIntent: Record<ChangeIntent, string> = {
    edit: t('ibRebates.formTitleEdit'),
    upgrade: t('ibRebates.formTitleUpgrade'),
    downgrade: t('ibRebates.formTitleDowngrade'),
  };
  const heading = !editingId ? t('ibRebates.newConfig') : titleByIntent[intent];

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
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted" aria-label={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>
        {editingId && (
          <p className="text-xs text-muted-foreground">
            {t('ibRebates.formEditHintPre')}{' '}
            <strong>{intent}</strong> {t('ibRebates.formEditHintPost')}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium block mb-1">{t('ibRebates.colUsername')}</span>
            <input
              required
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium block mb-1">{t('ibRebates.fieldFile')}</span>
            <input
              value={form.archivo}
              onChange={(e) => setForm({ ...form, archivo: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium block mb-1">
              {editingId ? t('ibRebates.fieldDateLocked') : t('ibRebates.fieldDate')}
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
                {t('ibRebates.fieldDateHint')}
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
            <span className="text-xs font-medium block mb-1">{t('ibRebates.fieldSyntheticLevel')}</span>
            <input
              type="number"
              value={form.syntheticos_level}
              onChange={(e) => setForm({ ...form, syntheticos_level: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium block mb-1">{t('ibRebates.fieldPropfirmLevel')}</span>
            <input
              type="number"
              value={form.propfirm_level}
              onChange={(e) => setForm({ ...form, propfirm_level: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block col-span-2">
            <span className="text-xs font-medium block mb-1">{t('ibRebates.fieldNotes')}</span>
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
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
          >
            {editingId ? t('common.save') : t('ibRebates.create')}
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
  const { t } = useI18n();
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
      const res = await apiFetch('/api/admin/ib-rebates/thresholds', {
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
          <h3 className="text-lg font-semibold">{t('ibRebates.thresholdsTitle')}</h3>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted" aria-label={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('ibRebates.thresholdsHint')}
        </p>
        <div className="space-y-3">
          <p className="text-sm font-medium">{t('ibRebates.modeInitial')}</p>
          <label className="block">
            <span className="text-xs">{t('ibRebates.daysYellowInitial')}</span>
            <input
              type="number"
              value={form.initial_yellow_days}
              onChange={(e) => setForm({ ...form, initial_yellow_days: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs">{t('ibRebates.daysRedInitial')}</span>
            <input
              type="number"
              value={form.initial_red_days}
              onChange={(e) => setForm({ ...form, initial_red_days: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <p className="text-sm font-medium pt-2">{t('ibRebates.modeRecurring')}</p>
          <label className="block">
            <span className="text-xs">{t('ibRebates.daysYellow')}</span>
            <input
              type="number"
              value={form.recurring_yellow_days}
              onChange={(e) => setForm({ ...form, recurring_yellow_days: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs">{t('ibRebates.daysOrange')}</span>
            <input
              type="number"
              value={form.recurring_orange_days}
              onChange={(e) => setForm({ ...form, recurring_orange_days: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs">{t('ibRebates.daysRed')}</span>
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
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {saving ? t('common.saving') : t('common.save')}
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
  const { t } = useI18n();
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
      const res = await apiFetch('/api/admin/ib-rebates/import', {
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
          <h3 className="text-lg font-semibold">{t('ibRebates.importTitle')}</h3>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted" aria-label={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>
        {result ? (
          <div className="space-y-2 text-sm">
            <p>{t('ibRebates.importTotal')} <strong>{result.total}</strong></p>
            <p>{t('ibRebates.importInserted')} <strong className="text-emerald-600">{result.inserted}</strong></p>
            <p>{t('ibRebates.importUpdated')} <strong className="text-blue-600">{result.updated}</strong></p>
            <p>{t('ibRebates.importSkipped')} <strong className="text-yellow-600">{result.skipped}</strong></p>
            {result.errors.length > 0 && (
              <div className="rounded p-2 bg-red-50 border border-red-200 text-xs max-h-32 overflow-y-auto dark:bg-red-950/40 dark:border-red-900">
                <p className="font-medium text-red-800 dark:text-red-300 mb-1">{t('ibRebates.importErrors')}</p>
                {result.errors.map((er, i) => <p key={i}>{er}</p>)}
              </div>
            )}
            <button
              onClick={onImported}
              className="w-full mt-3 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
            >
              {t('common.close')}
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t('ibRebates.importColumns')}
            </p>
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              required
              className="w-full text-sm"
            />
            <label className="block">
              <span className="text-xs font-medium block mb-1">{t('ibRebates.importModeLabel')}</span>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'skip' | 'update')}
                className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm"
              >
                <option value="skip">{t('ibRebates.importModeSkip')}</option>
                <option value="update">{t('ibRebates.importModeUpdate')}</option>
              </select>
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-muted"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={uploading || !file}
                className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {uploading ? t('ibRebates.importing') : t('ibRebates.importAction')}
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
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-card rounded-xl shadow-xl p-6 max-w-2xl w-full space-y-3 max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">{t('ibRebates.historyTitle')}</h3>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-muted" aria-label={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>
        {entries.length === 0 ? (
          <EmptyState compact title={t('ibRebates.historyEmptyTitle')} description={t('ibRebates.historyEmptyDesc')} />
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div key={e.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex justify-between mb-1">
                  <span className="font-medium capitalize">{t(`ibRebates.changeType.${e.change_type}`)}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(e.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('ibRebates.historyBy', { name: e.changed_by_name || t('ibRebates.unknownUser') })}
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
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
