'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { AlertTriangle, Plus, Trash2, Check, Settings2, X } from 'lucide-react';
import type { CommercialProfile } from '@/lib/types';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { formatCurrency, cn } from '@/lib/utils';
import { hrRoleLabel } from '@/lib/hr/domain';
import { WARNING_MOTIVES, type WarningMotive } from '@/lib/hr/net-deposit';
import type { HrWarningsSlice } from '@/lib/hr/overview';
import { useHrPeriod } from './hr-period-context';

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña Warnings — los llamados de atención del mes.
//
// Daniela pidió tres cosas y nada más: los tres motivos («uno depósito net
// deposit, el segundo es creación de líneas nuevas y el tercero es creación de
// equipo»), que sea mensual, y poder ver cuántos acumula cada uno «cuando
// tienen dos o tres».
//
// EL SISTEMA SUGIERE, LA PERSONA FIRMA. El bloque de sugerencias de arriba se
// calcula solo (quién quedó bajo la meta de su salario) pero NO existe como
// warning hasta que alguien aprieta el tick. Es el mismo criterio del resto del
// dashboard y acá pesa más que en otros lados: dos o tres de estos terminan en
// un despido.
//
// El primer mes no aparece nunca en las sugerencias — «el primer mes se les
// paga igual, es el riesgo que corre la empresa». La exención la aplica el
// servidor contra hire_date; no hay forma de apagarla desde acá.
// ─────────────────────────────────────────────────────────────────────────────

// Las formas de los warnings, las sugerencias y las métricas ya no se declaran
// acá: son las del contrato del overview (src/lib/hr/overview.ts). Tenerlas
// escritas dos veces era el modo de falla número uno del repo en versión tipos.

type Goal = { id?: string; salary: number | string; min_net_deposit: number | string };

/** Literales vacíos estables: un `[]` nuevo por render invalida los memos. */
const EMPTY_WARNINGS: HrWarningsSlice['ofMonth'] = [];
const EMPTY_SUGGESTIONS: HrWarningsSlice['suggestions'] = [];
const EMPTY_TOTALS: HrWarningsSlice['totals'] = {};

const MOTIVE_LABEL_KEY: Record<WarningMotive, string> = {
  net_deposit: 'hr.warningMotiveNetDeposit',
  new_lines: 'hr.warningMotiveNewLines',
  team_creation: 'hr.warningMotiveTeamCreation',
};

// El mes ya no se elige acá: viene del selector único del módulo
// (rrhh/_components/hr-period-context.tsx), igual que para el resto de las
// pestañas. El default sigue siendo el mes ANTERIOR — el corriente todavía
// corre — sólo que ahora lo decide el módulo entero, no esta pantalla.

export function WarningsTab({ profiles }: { profiles: CommercialProfile[] }) {
  const { t } = useI18n();
  // Todo lo del mes sale del overview del módulo — una sola llamada compartida
  // con las demás pestañas. Antes esta pantalla pedía /api/admin/hr-warnings
  // (que repite la RPC del rollup) cada vez que se entraba.
  const { month, overview, loading, error, refetch } = useHrPeriod();
  const warningsSlice = overview?.data.warnings ?? null;
  const warnings = warningsSlice?.ofMonth ?? EMPTY_WARNINGS;
  const totals = warningsSlice?.totals ?? EMPTY_TOTALS;
  const suggestions = warningsSlice?.suggestions ?? EMPTY_SUGGESTIONS;
  // Las metas SÍ son estado local: el editor las modifica antes de guardar. Se
  // re-siembran cada vez que llega un overview nuevo.
  const [goals, setGoals] = useState<Goal[]>([]);
  const loadError = error || (!!overview && overview.partial.includes('warnings'));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showGoals, setShowGoals] = useState(false);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of profiles) m.set(p.id, p.name);
    return m;
  }, [profiles]);

  // Las métricas se indexan una vez por overview. Los literales vacíos van en
  // constantes de módulo (arriba) para no crear un array nuevo en cada render y
  // recalcular esto sin motivo.
  const metricById = useMemo(() => {
    const m = new Map<string, HrWarningsSlice['metrics'][number]>();
    for (const x of warningsSlice?.metrics ?? []) m.set(x.profileId, x);
    return m;
  }, [warningsSlice]);

  // `goalRows` viaja aparte en la respuesta porque el editor necesita el `id`
  // de cada escalón; el overview normaliza los números para el cálculo.
  const goalRows = overview?.goalRows;
  useEffect(() => { setGoals(goalRows ?? []); }, [goalRows]);

  /** Recargar = invalidar el overview del mes. No hay una segunda carga acá. */
  const load = useCallback(async () => { refetch(); }, [refetch]);

  const flash = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  };

  const createWarning = async (profile_id: string, motive: WarningMotive, detail?: string) => {
    setBusyId(`${profile_id}:${motive}`);
    try {
      const res = await apiFetch('/api/admin/hr-warnings', {
        method: 'POST',
        body: JSON.stringify({ action: 'create', profile_id, month, motive, detail }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'error');
      flash('success', t('hr.warningSaved'));
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : t('hr.warningError'));
    } finally {
      setBusyId(null);
    }
  };

  const deleteWarning = async (id: string) => {
    setBusyId(id);
    try {
      const res = await apiFetch('/api/admin/hr-warnings', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete', id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'error');
      flash('success', t('hr.warningDeleted'));
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : t('hr.warningError'));
    } finally {
      setBusyId(null);
    }
  };

  const saveGoals = async () => {
    setBusyId('goals');
    try {
      const res = await apiFetch('/api/admin/hr-warnings', {
        method: 'POST',
        body: JSON.stringify({
          action: 'saveGoals',
          goals: goals.map((g) => ({ salary: Number(g.salary), min_net_deposit: Number(g.min_net_deposit) })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'error');
      flash('success', t('hr.warningGoalsSaved'));
      await load();
    } catch (err) {
      flash('error', err instanceof Error ? err.message : t('hr.warningError'));
    } finally {
      setBusyId(null);
    }
  };

  // Perfiles con dos o más acumulados — el corte que pidió Daniela.
  const repeatOffenders = Object.entries(totals).filter(([, n]) => n >= 2).length;

  return (
    <div className="space-y-6">
      {toast && (
        <div className={cn('px-4 py-3 rounded-lg text-sm', toast.type === 'success'
          ? 'bg-positive/10 text-positive border border-positive/30'
          : 'bg-negative/10 text-negative border border-negative/30')}>
          {toast.msg}
        </div>
      )}

      {/* ── Cabecera: mes + acciones ────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        {/* El mes lo pone el selector del módulo, arriba de las pestañas. */}
        <div />
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowGoals((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted"
          >
            <Settings2 className="w-4 h-4" /> {t('hr.warningGoals')}
          </button>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
          >
            <Plus className="w-4 h-4" /> {t('hr.warningNew')}
          </button>
        </div>
      </div>

      {/* ── Metas por salario ───────────────────────────────────────────── */}
      {showGoals && (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div>
            <h3 className="text-sm font-semibold">{t('hr.warningGoals')}</h3>
            <p className="text-xs text-muted-foreground mt-1">{t('hr.warningGoalsHint')}</p>
          </div>
          <div className="space-y-2">
            {goals.map((g, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="number"
                  aria-label={t('hr.warningGoalSalary')}
                  value={g.salary}
                  onChange={(e) => setGoals((prev) => prev.map((x, j) => (j === i ? { ...x, salary: e.target.value } : x)))}
                  className="w-32 px-2 py-1 rounded border border-border bg-card text-base sm:text-sm"
                />
                <span className="text-muted-foreground text-sm">→</span>
                <input
                  type="number"
                  aria-label={t('hr.warningGoalMin')}
                  value={g.min_net_deposit}
                  onChange={(e) => setGoals((prev) => prev.map((x, j) => (j === i ? { ...x, min_net_deposit: e.target.value } : x)))}
                  className="w-36 px-2 py-1 rounded border border-border bg-card text-base sm:text-sm"
                />
                <button
                  onClick={() => setGoals((prev) => prev.filter((_, j) => j !== i))}
                  className="text-muted-foreground hover:text-red-500"
                  aria-label={t('common.delete')}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setGoals((prev) => [...prev, { salary: '', min_net_deposit: '' }])}
              className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted"
            >
              {t('hr.warningGoalAdd')}
            </button>
            <button
              onClick={saveGoals}
              disabled={busyId === 'goals'}
              className="px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {t('common.save')}
            </button>
          </div>
        </div>
      )}

      {/* ── Alta manual ─────────────────────────────────────────────────── */}
      {showForm && (
        <NewWarningForm
          profiles={profiles}
          onCancel={() => setShowForm(false)}
          onSave={async (profileId, motive, detail) => {
            await createWarning(profileId, motive, detail);
            setShowForm(false);
          }}
        />
      )}

      {/* ── Sugerencias ─────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-warning/40 bg-warning/5 p-4">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle className="w-4 h-4 text-warning" />
          <h3 className="text-sm font-semibold">{t('hr.warningSuggestions')}</h3>
          <span className="text-xs text-muted-foreground">({suggestions.length})</span>
        </div>
        <p className="text-xs text-muted-foreground mb-3">{t('hr.warningSuggestionsHint')}</p>
        {loading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : suggestions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('hr.warningNoSuggestions')}</p>
        ) : (
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('common.name')}</th>
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.role')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('hr.warningNet')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('hr.warningGoal')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium">{t('hr.warningShortfall')}</th>
                  <th className="text-right py-2 px-3"></th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s) => (
                  <tr key={s.profileId} className="border-b border-border/50">
                    <td className="py-2 px-3 font-medium">{s.name}</td>
                    <td className="py-2 px-3 hidden sm:table-cell text-muted-foreground">{hrRoleLabel(s.role)}</td>
                    <td className="py-2 px-3 text-right">{formatCurrency(s.net)}</td>
                    <td className="py-2 px-3 text-right text-muted-foreground">{formatCurrency(s.goal)}</td>
                    <td className="py-2 px-3 text-right text-negative">{formatCurrency(s.shortfall)}</td>
                    <td className="py-2 px-3 text-right">
                      <button
                        onClick={() => createWarning(s.profileId, 'net_deposit', t('hr.warningAutoDetail'))}
                        disabled={busyId === `${s.profileId}:net_deposit`}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[var(--color-primary)] text-white text-xs font-medium hover:opacity-90 disabled:opacity-50"
                      >
                        <Check className="w-3 h-3" /> {t('hr.warningConfirm')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Warnings cargados ───────────────────────────────────────────── */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">{t('hr.warningsOfMonth')}</h3>
          <span className="text-xs text-muted-foreground">
            {t('hr.warningRepeatOffenders')}: {repeatOffenders}
          </span>
        </div>
        {loadError ? (
          <p className="text-sm text-negative">{t('hr.warningError')}</p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : warnings.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">{t('hr.warningNone')}</p>
        ) : (
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <table className="w-full text-sm min-w-[680px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('common.name')}</th>
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium">{t('hr.warningMotive')}</th>
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium hidden md:table-cell">{t('hr.warningDetail')}</th>
                  <th className="text-right py-2 px-3 text-muted-foreground font-medium hidden sm:table-cell">{t('hr.warningNet')}</th>
                  <th className="text-center py-2 px-3 text-muted-foreground font-medium">{t('hr.warningAccumulated')}</th>
                  <th className="text-left py-2 px-3 text-muted-foreground font-medium hidden lg:table-cell">{t('hr.warningCreatedBy')}</th>
                  <th className="text-right py-2 px-3"></th>
                </tr>
              </thead>
              <tbody>
                {warnings.map((w) => {
                  const total = totals[w.profile_id] ?? 1;
                  const metric = metricById.get(w.profile_id);
                  return (
                    <tr key={w.id} className="border-b border-border/50 hover:bg-muted/50">
                      <td className="py-2 px-3 font-medium">{nameById.get(w.profile_id) ?? w.profile_id}</td>
                      <td className="py-2 px-3">{t(MOTIVE_LABEL_KEY[w.motive as WarningMotive] ?? 'hr.warningMotive')}</td>
                      <td className="py-2 px-3 text-muted-foreground text-xs max-w-[240px] truncate hidden md:table-cell">{w.detail || '-'}</td>
                      <td className="py-2 px-3 text-right hidden sm:table-cell">
                        {metric ? formatCurrency(metric.net) : '-'}
                        {metric?.goal != null && (
                          <span className="text-muted-foreground text-xs"> / {formatCurrency(metric.goal)}</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-center">
                        {/* Dos o más se pintan: es el umbral en el que Daniela
                            empieza a mirar de cerca a alguien. */}
                        <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium',
                          total >= 3 ? 'bg-negative/10 text-negative'
                            : total >= 2 ? 'bg-warning/10 text-warning'
                            : 'bg-muted text-muted-foreground')}>
                          {total}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-muted-foreground text-xs hidden lg:table-cell">{w.created_by_name || '-'}</td>
                      <td className="py-2 px-3 text-right">
                        <button
                          onClick={() => deleteWarning(w.id)}
                          disabled={busyId === w.id}
                          className="text-muted-foreground hover:text-red-500 disabled:opacity-50"
                          aria-label={t('common.delete')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Alta a mano: cualquiera de los tres motivos, sobre cualquier perfil. */
function NewWarningForm({ profiles, onCancel, onSave }: {
  profiles: CommercialProfile[];
  onCancel: () => void;
  onSave: (profileId: string, motive: WarningMotive, detail?: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [profileId, setProfileId] = useState('');
  const [motive, setMotive] = useState<WarningMotive>('net_deposit');
  const [detail, setDetail] = useState('');
  const [saving, setSaving] = useState(false);

  const sorted = useMemo(
    () => [...profiles].sort((a, b) => a.name.localeCompare(b.name)),
    [profiles],
  );

  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <h3 className="text-sm font-semibold">{t('hr.warningNew')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <select
          aria-label={t('hr.warningProfile')}
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
          className="px-3 py-1.5 rounded-lg border border-border bg-card text-base sm:text-sm"
        >
          <option value="">{t('hr.warningProfile')}</option>
          {sorted.map((p) => (
            <option key={p.id} value={p.id}>{p.name} — {hrRoleLabel(p.role)}</option>
          ))}
        </select>
        <select
          aria-label={t('hr.warningMotive')}
          value={motive}
          onChange={(e) => setMotive(e.target.value as WarningMotive)}
          className="px-3 py-1.5 rounded-lg border border-border bg-card text-base sm:text-sm"
        >
          {WARNING_MOTIVES.map((m) => (
            <option key={m} value={m}>{t(MOTIVE_LABEL_KEY[m])}</option>
          ))}
        </select>
        <input
          type="text"
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder={t('hr.warningDetail')}
          className="px-3 py-1.5 rounded-lg border border-border bg-card text-base sm:text-sm"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={async () => {
            if (!profileId) return;
            setSaving(true);
            await onSave(profileId, motive, detail.trim() || undefined);
            setSaving(false);
          }}
          disabled={!profileId || saving}
          className="px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
        >
          {saving ? t('hr.saving') : t('common.save')}
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted">
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
