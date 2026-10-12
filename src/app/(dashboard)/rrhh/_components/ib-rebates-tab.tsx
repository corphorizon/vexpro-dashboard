'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { NUM_CLASS } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { Segmented } from '@/components/ui/segmented';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { ActionButton } from '@/components/ui/action-button';
import { cn } from '@/lib/utils';
import {
  Plus, Edit2, Trash2, ChevronUp, ChevronDown,
  History, Settings, Upload, CheckCircle2,
} from 'lucide-react';
import type {
  IbRebateConfig, IbRebateThresholds, AlertResult, IbRebateHistoryEntry,
} from '@/lib/ib-rebates/types';
import { DEFAULT_THRESHOLDS } from '@/lib/ib-rebates/types';
import { computeAlert } from '@/lib/ib-rebates/alerts';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { FilePick, HrModal, ROW_ACTION_CLASS, ROW_DANGER_CLASS, SearchField } from './hr-ui';
import { IB_ALERT_KIND } from './hr-view';

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña CONFIG. IB (rebates por IB y sus alertas de antigüedad).
//
// «Libro mayor» (2026-10-12) — sólo presentación; cargas, PATCH/POST/DELETE,
// umbrales e importación no cambiaron:
//   · Las alertas verde/amarillo/naranja/rojo eran paleta cruda con `dark:`
//     (24 clases sólo en el badge). Ahora StatusBadge por significado
//     (IB_ALERT_KIND en hr-view.ts: verde ok, amarillo y naranja pend, rojo
//     bad); la etiqueta —que ya decía el nivel y los días— distingue
//     amarillo de naranja. «Metas cumplidas» = ok.
//   · Subió/bajó de nivel iban en azul/violeta: una dirección no es buena ni
//     mala para la plata. Ahora gris con flecha.
//   · El filtro de alerta pasó de <select> a Segmented con conteos; la tabla
//     a FinTable; los cuatro modales a HrModal con Field/Input/Select.
//   · El resumen de importación pintaba insertados/actualizados/salteados en
//     verde/azul/amarillo: son conteos, no estados. Los errores, Notice `bad`.
// Medición (sin comentarios): antes 63 clases de paleta cruda, 17 `dark:` de
// color, 6 `text-[10/11px]` y 31 tokens legados; después 0 / 0 / 0 / 0.
// ─────────────────────────────────────────────────────────────────────────────

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
const FILTERS: readonly FilterAlert[] = ['all', 'green', 'yellow', 'orange', 'red', 'goals_met'];
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

  // Conteo por filtro sobre la búsqueda: el Segmented dice cuántas filas suma
  // cada opción antes de tocarla (un filtro olvidado se ve, reglas §1.2).
  const filterCounts = useMemo(() => {
    const counts: Record<FilterAlert, number> = { all: 0, green: 0, yellow: 0, orange: 0, red: 0, goals_met: 0 };
    const q = search.toLowerCase();
    for (const c of configs) {
      if (search && !c.username.toLowerCase().includes(q)) continue;
      counts.all += 1;
      counts[computeAlert(c, thresholds).level] += 1;
      if (c.goals_met) counts.goals_met += 1;
    }
    return counts;
  }, [configs, search, thresholds]);

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

  const renderAlertBadge = (alert: AlertResult) => (
    <StatusBadge
      kind={IB_ALERT_KIND[alert.level]}
      label={`${t(`ibRebates.alert.${alert.mode}.${alert.level}`)} (${t('ibRebates.daysShort', { days: String(alert.daysSince) })})`}
    />
  );

  // Subió / bajó de nivel: es una dirección, no algo bueno o malo para el
  // dinero (un downgrade puede ser lo correcto). Gris con flecha.
  const renderChangeTypeBadge = (type: IbRebateConfig['last_change_type']) => {
    if (type === 'upgrade') {
      return (
        <span className="inline-flex items-center gap-0.5 text-[12px] font-medium text-text-2">
          <ChevronUp aria-hidden className="size-3.5" />{t('ibRebates.badgeUpgraded')}
        </span>
      );
    }
    if (type === 'downgrade') {
      return (
        <span className="inline-flex items-center gap-0.5 text-[12px] font-medium text-text-2">
          <ChevronDown aria-hidden className="size-3.5" />{t('ibRebates.badgeDowngraded')}
        </span>
      );
    }
    return null;
  };

  const statusCell = (c: IbRebateConfig) => (
    <span className="flex flex-col items-end gap-1 min-[720px]:items-start">
      {renderAlertBadge(computeAlert(c, thresholds))}
      {renderChangeTypeBadge(c.last_change_type)}
      {c.goals_met && <StatusBadge kind="ok" label={t('ibRebates.goalsMet')} />}
    </span>
  );

  const LEVEL_COLS = ['stp', 'ecn', 'cent', 'pro', 'vip', 'elite'] as const;

  const columns: FinColumn<IbRebateConfig>[] = [
    {
      key: 'username',
      header: t('ibRebates.colUsername'),
      cell: (c) => c.username,
      meta: (c) =>
        `${new Date(c.last_update_date).toLocaleDateString()}${
          c.last_update_date !== c.original_config_date ? ` · ${t('ibRebates.modified')}` : ''
        }`,
    },
    {
      key: 'original',
      header: t('ibRebates.colOriginalDate'),
      hideSm: true,
      cell: (c) => <span className="tabular-nums text-text-2">{new Date(c.original_config_date).toLocaleDateString()}</span>,
    },
    ...LEVEL_COLS.map((k): FinColumn<IbRebateConfig> => ({
      key: k,
      header: k.toUpperCase(),
      align: 'center',
      hideSm: true,
      cell: (c) => <span className={NUM_CLASS}>{c[k]}</span>,
    })),
    {
      key: 'synthetic',
      header: t('ibRebates.colSynthetic'),
      align: 'center',
      hideSm: true,
      cell: (c) => <span className={NUM_CLASS}>{c.syntheticos_level}</span>,
    },
    {
      key: 'propfirm',
      header: 'PropFirm',
      align: 'center',
      hideSm: true,
      cell: (c) => <span className={NUM_CLASS}>{c.propfirm_level}</span>,
    },
    { key: 'status', header: t('common.status'), cardSide: 'right', cell: statusCell },
  ];

  const rowActions = (c: IbRebateConfig) => (
    <>
      <button type="button" onClick={() => openEdit(c, 'edit')} title={t('common.edit')} aria-label={t('common.edit')} className={ROW_ACTION_CLASS}>
        <Edit2 aria-hidden className="size-[15px]" strokeWidth={1.75} />
      </button>
      <button type="button" onClick={() => openEdit(c, 'upgrade')} title={t('ibRebates.upgradeTitle')} aria-label={t('ibRebates.upgradeTitle')} className={ROW_ACTION_CLASS}>
        <ChevronUp aria-hidden className="size-[15px]" strokeWidth={1.75} />
      </button>
      <button type="button" onClick={() => openEdit(c, 'downgrade')} title={t('ibRebates.downgradeTitle')} aria-label={t('ibRebates.downgradeTitle')} className={ROW_ACTION_CLASS}>
        <ChevronDown aria-hidden className="size-[15px]" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={() => handleToggleGoals(c)}
        title={c.goals_met ? t('ibRebates.unsetGoals') : t('ibRebates.setGoals')}
        aria-label={c.goals_met ? t('ibRebates.unsetGoals') : t('ibRebates.setGoals')}
        aria-pressed={c.goals_met}
        className={ROW_ACTION_CLASS}
      >
        <CheckCircle2 aria-hidden className="size-[15px]" strokeWidth={1.75} />
      </button>
      <button type="button" onClick={() => handleViewHistory(c.id)} title={t('ibRebates.viewHistory')} aria-label={t('ibRebates.viewHistory')} className={ROW_ACTION_CLASS}>
        <History aria-hidden className="size-[15px]" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={() => handleDelete(c)}
        title={t('common.delete')}
        aria-label={t('common.delete')}
        className={ROW_DANGER_CLASS}
      >
        <Trash2 aria-hidden className="size-[15px]" strokeWidth={1.75} />
      </button>
    </>
  );

  if (loading) {
    return <p className="p-8 text-center text-[13px] text-text-3">{t('ibRebates.loading')}</p>;
  }

  const filterLabels: Record<FilterAlert, string> = {
    all: t('ibRebates.filterAll'),
    green: t('ibRebates.filterGreen'),
    yellow: t('ibRebates.filterYellow'),
    orange: t('ibRebates.filterOrange'),
    red: t('ibRebates.filterRed'),
    goals_met: t('ibRebates.filterGoalsMet'),
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <Panel
        title={t('hr.ibConfigTab')}
        hint={t('hrv.rowsShowing', { shown: String(filtered.length), total: String(configs.length) })}
        actions={
          <>
            <ActionButton onClick={() => setShowImport(true)}>
              <Upload aria-hidden className="size-[15px]" strokeWidth={1.75} /> {t('ibRebates.importExcel')}
            </ActionButton>
            <ActionButton onClick={() => setShowThresholds(true)}>
              <Settings aria-hidden className="size-[15px]" strokeWidth={1.75} /> {t('ibRebates.thresholds')}
            </ActionButton>
            <ActionButton variant="primary" onClick={openCreate}>
              <Plus aria-hidden className="size-[15px]" strokeWidth={1.75} /> {t('ibRebates.newConfig')}
            </ActionButton>
          </>
        }
        flush
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t('ibRebates.searchPlaceholder')}
            className="max-w-[320px] flex-1"
          />
          <Segmented
            options={FILTERS.map((f) => ({ value: f, label: filterLabels[f], count: filterCounts[f] }))}
            value={filterAlert}
            onChange={setFilterAlert}
            aria-label={t('common.status')}
            className="max-w-full flex-wrap"
          />
        </div>
        <FinTable
          columns={columns}
          rows={filtered}
          rowKey={(c) => c.id}
          caption={t('hr.ibConfigTab')}
          empty={<EmptyState compact title={t('ibRebates.emptyTitle')} description={t('ibRebates.emptyDesc')} />}
          rowActions={rowActions}
        />
      </Panel>

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
    <HrModal
      title={heading}
      hint={
        editingId ? (
          <>
            {t('ibRebates.formEditHintPre')} <strong className="font-semibold text-text-2">{intent}</strong>{' '}
            {t('ibRebates.formEditHintPost')}
          </>
        ) : undefined
      }
      onClose={onClose}
      onSubmit={onSubmit}
      size="lg"
      footer={
        <>
          <ActionButton variant="ghost" onClick={onClose}>{t('common.cancel')}</ActionButton>
          <ActionButton variant="primary" type="submit">
            {editingId ? t('common.save') : t('ibRebates.create')}
          </ActionButton>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('ibRebates.colUsername')} required>
          <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </Field>
        <Field label={t('ibRebates.fieldFile')}>
          <Input value={form.archivo} onChange={(e) => setForm({ ...form, archivo: e.target.value })} />
        </Field>
        <Field
          label={editingId ? t('ibRebates.fieldDateLocked') : t('ibRebates.fieldDate')}
          hint={editingId ? t('ibRebates.fieldDateHint') : undefined}
          required
        >
          <Input
            type="date"
            disabled={!!editingId}
            value={form.config_date}
            onChange={(e) => setForm({ ...form, config_date: e.target.value })}
          />
        </Field>
        <div />
        {(['stp', 'ecn', 'cent', 'pro', 'vip', 'elite'] as const).map((k) => (
          <Field key={k} label={k.toUpperCase()}>
            <Input
              type="number"
              step="0.01"
              value={form[k]}
              onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
              className="text-right tabular-nums"
            />
          </Field>
        ))}
        <Field label={t('ibRebates.fieldSyntheticLevel')}>
          <Input
            type="number"
            value={form.syntheticos_level}
            onChange={(e) => setForm({ ...form, syntheticos_level: Number(e.target.value) })}
            className="text-right tabular-nums"
          />
        </Field>
        <Field label={t('ibRebates.fieldPropfirmLevel')}>
          <Input
            type="number"
            value={form.propfirm_level}
            onChange={(e) => setForm({ ...form, propfirm_level: Number(e.target.value) })}
            className="text-right tabular-nums"
          />
        </Field>
        <Field label={t('ibRebates.fieldNotes')} className="col-span-2">
          <Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />
        </Field>
      </div>
    </HrModal>
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

  const dayField = (key: keyof typeof form, labelKey: string) => (
    <Field label={t(labelKey)}>
      <Input
        type="number"
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
        className="text-right tabular-nums"
      />
    </Field>
  );

  return (
    <HrModal
      title={t('ibRebates.thresholdsTitle')}
      hint={t('ibRebates.thresholdsHint')}
      onClose={onClose}
      onSubmit={submit}
      size="sm"
      footer={
        <>
          <ActionButton variant="ghost" onClick={onClose}>{t('common.cancel')}</ActionButton>
          <ActionButton variant="primary" type="submit" loading={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </ActionButton>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] font-semibold text-foreground">{t('ibRebates.modeInitial')}</p>
        {dayField('initial_yellow_days', 'ibRebates.daysYellowInitial')}
        {dayField('initial_red_days', 'ibRebates.daysRedInitial')}
        <p className="pt-2 text-[13px] font-semibold text-foreground">{t('ibRebates.modeRecurring')}</p>
        {dayField('recurring_yellow_days', 'ibRebates.daysYellow')}
        {dayField('recurring_orange_days', 'ibRebates.daysOrange')}
        {dayField('recurring_red_days', 'ibRebates.daysRed')}
      </div>
    </HrModal>
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

  if (result) {
    // El resultado es un recuento: los números van en el color de su
    // significado sólo donde lo tienen (errores = neg); el resto, tabular.
    return (
      <HrModal
        title={t('ibRebates.importTitle')}
        onClose={onImported}
        size="sm"
        footer={<ActionButton variant="primary" onClick={onImported}>{t('common.close')}</ActionButton>}
      >
        <dl className="space-y-1.5 text-[13px]">
          {([
            ['ibRebates.importTotal', result.total],
            ['ibRebates.importInserted', result.inserted],
            ['ibRebates.importUpdated', result.updated],
            ['ibRebates.importSkipped', result.skipped],
          ] as const).map(([k, n]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-text-2">{t(k)}</dt>
              <dd className={cn(NUM_CLASS, 'font-semibold text-foreground')}>{n}</dd>
            </div>
          ))}
        </dl>
        {result.errors.length > 0 && (
          <Notice kind="bad" title={`${t('ibRebates.importErrors')} ${result.errors.length}`} className="mt-3">
            <div className="max-h-32 overflow-y-auto text-[12px]">
              {result.errors.map((er, i) => <p key={i}>{er}</p>)}
            </div>
          </Notice>
        )}
      </HrModal>
    );
  }

  return (
    <HrModal
      title={t('ibRebates.importTitle')}
      hint={t('ibRebates.importColumns')}
      onClose={onClose}
      onSubmit={submit}
      size="sm"
      footer={
        <>
          <ActionButton variant="ghost" onClick={onClose}>{t('common.cancel')}</ActionButton>
          <ActionButton variant="primary" type="submit" disabled={!file} loading={uploading}>
            {uploading ? t('ibRebates.importing') : t('ibRebates.importAction')}
          </ActionButton>
        </>
      }
    >
      <div className="space-y-3">
        <FilePick file={file} onFile={setFile} placeholder={t('ibRebates.importExcel')} accept=".xlsx,.xls" />
        <Field label={t('ibRebates.importModeLabel')}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'skip' | 'update')}>
            <option value="skip">{t('ibRebates.importModeSkip')}</option>
            <option value="update">{t('ibRebates.importModeUpdate')}</option>
          </Select>
        </Field>
      </div>
    </HrModal>
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
    <HrModal
      title={t('ibRebates.historyTitle')}
      onClose={onClose}
      size="lg"
      footer={<ActionButton onClick={onClose}>{t('common.close')}</ActionButton>}
    >
      {entries.length === 0 ? (
        <EmptyState compact title={t('ibRebates.historyEmptyTitle')} description={t('ibRebates.historyEmptyDesc')} />
      ) : (
        <ol className="divide-y divide-border rounded-ui-md border border-border">
          {entries.map((e) => (
            <li key={e.id} className="px-3 py-2.5 text-[13px]">
              <div className="flex justify-between gap-3">
                <span className="font-medium capitalize text-foreground">{t(`ibRebates.changeType.${e.change_type}`)}</span>
                <span className="text-[12px] tabular-nums text-text-3">{new Date(e.created_at).toLocaleString()}</span>
              </div>
              <p className="text-[12px] text-text-3">
                {t('ibRebates.historyBy', { name: e.changed_by_name || t('ibRebates.unknownUser') })}
              </p>
              {e.notes && <p className="mt-1 text-[12.5px] text-text-2">{e.notes}</p>}
            </li>
          ))}
        </ol>
      )}
    </HrModal>
  );
}
