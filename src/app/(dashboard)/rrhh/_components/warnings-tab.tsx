'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Plus, Trash2, Check, Settings2, X } from 'lucide-react';
import type { CommercialProfile } from '@/lib/types';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money } from '@/components/ui/money';
import { StatusBadge } from '@/components/ui/status-badge';
import { Field, Input, Select } from '@/components/ui/field';
import { useToasts } from '@/components/ui/toast';
import { ActionButton } from '@/components/ui/action-button';
import { hrRoleLabel } from '@/lib/hr/domain';
import { WARNING_MOTIVES, type WarningMotive } from '@/lib/hr/net-deposit';
import type { HrWarningsSlice } from '@/lib/hr/overview';
import { useHrPeriod } from './hr-period-context';
import { ROW_DANGER_CLASS } from './hr-ui';
import { WARNING_WATCH_AT, warningSeverity } from './hr-view';

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
//
// ── «Libro mayor» (2026-10-12) — sólo presentación ─────────────────────────
// Sugerencias y warnings del mes en Panel + FinTable; el acumulado por
// persona es un StatusBadge por severidad (hr-view.ts `warningSeverity`: 2+
// `pend`, 3+ `bad`, el mismo umbral de antes); las sugerencias llevan un
// badge `pend` con cuántas faltan firmar; metas y alta manual con
// Field/Input/Select; los avisos de éxito/error al toast flotante. Medición
// (sin comentarios): antes 6 clases de paleta cruda y 52 tokens legados;
// después 0 / 0.
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

  const { toast, ToastHost } = useToasts();
  const flash = (type: 'success' | 'error', msg: string) => {
    if (type === 'success') toast.success(msg);
    else toast.error(msg);
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
  const repeatOffenders = Object.entries(totals).filter(([, n]) => n >= WARNING_WATCH_AT).length;

  type Suggestion = HrWarningsSlice['suggestions'][number];
  type WarningRow = HrWarningsSlice['ofMonth'][number];

  const suggestionColumns: FinColumn<Suggestion>[] = [
    { key: 'name', header: t('common.name'), cell: (s2) => s2.name, meta: (s2) => hrRoleLabel(s2.role) },
    { key: 'net', header: t('hr.warningNet'), kind: 'money', value: (s2) => s2.net, subtotal: false },
    {
      key: 'goal',
      header: t('hr.warningGoal'),
      kind: 'money',
      hideSm: true,
      money: { tone: 'neutral' },
      value: (s2) => s2.goal,
      subtotal: false,
    },
    // Lo que falta para la meta: plata que NO entró, la noticia es negativa.
    {
      key: 'shortfall',
      header: t('hr.warningShortfall'),
      kind: 'money',
      money: { tone: 'neg' },
      value: (s2) => s2.shortfall,
      subtotal: false,
    },
  ];

  const warningColumns: FinColumn<WarningRow>[] = [
    {
      key: 'name',
      header: t('common.name'),
      cell: (w) => nameById.get(w.profile_id) ?? w.profile_id,
      meta: (w) => t(MOTIVE_LABEL_KEY[w.motive as WarningMotive] ?? 'hr.warningMotive'),
      mobileMeta: (w) => {
        const total = totals[w.profile_id] ?? 1;
        return <StatusBadge kind={warningSeverity(total)} label={t('hrv.accumulatedN', { n: String(total) })} />;
      },
    },
    {
      key: 'detail',
      header: t('hr.warningDetail'),
      hideSm: true,
      cell: (w) => (
        <span className="block max-w-[240px] truncate text-text-2" title={w.detail ?? undefined}>
          {w.detail || '—'}
        </span>
      ),
    },
    {
      key: 'net',
      header: t('hr.warningNet'),
      align: 'right',
      hideSm: true,
      cell: (w) => {
        const metric = metricById.get(w.profile_id);
        if (!metric) return <Money value={null} nullLabel={t('ui.noData')} />;
        return (
          <span className="inline-flex items-baseline justify-end gap-1">
            <Money value={metric.net} />
            {metric.goal != null && (
              <span className="text-[12px] text-text-3">
                / <Money value={metric.goal} tone="neutral" />
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'accumulated',
      header: t('hr.warningAccumulated'),
      align: 'center',
      hideSm: true,
      // Dos o más se pintan: es el umbral en el que Daniela empieza a mirar
      // de cerca a alguien (pend); tres, el de la charla seria (bad).
      cell: (w) => {
        const total = totals[w.profile_id] ?? 1;
        return <StatusBadge kind={warningSeverity(total)} label={String(total)} />;
      },
    },
    {
      key: 'createdBy',
      header: t('hr.warningCreatedBy'),
      hideSm: true,
      cell: (w) => <span className="text-text-2">{w.created_by_name || '—'}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      {ToastHost}

      {/* ── Acciones (el mes lo pone el selector del módulo) ─────────────── */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ActionButton onClick={() => setShowGoals((v) => !v)} aria-expanded={showGoals}>
          <Settings2 aria-hidden className="size-[15px]" strokeWidth={1.75} /> {t('hr.warningGoals')}
        </ActionButton>
        <ActionButton variant="primary" onClick={() => setShowForm((v) => !v)} aria-expanded={showForm}>
          <Plus aria-hidden className="size-[15px]" strokeWidth={1.75} /> {t('hr.warningNew')}
        </ActionButton>
      </div>

      {/* ── Metas por salario ───────────────────────────────────────────── */}
      {showGoals && (
        <Panel
          title={t('hr.warningGoals')}
          hint={t('hr.warningGoalsHint')}
          footer={
            <span className="flex flex-wrap items-center gap-2">
              <ActionButton onClick={() => setGoals((prev) => [...prev, { salary: '', min_net_deposit: '' }])}>
                {t('hr.warningGoalAdd')}
              </ActionButton>
              <ActionButton onClick={saveGoals} loading={busyId === 'goals'}>
                {t('common.save')}
              </ActionButton>
            </span>
          }
        >
          <div className="space-y-2">
            {goals.map((g, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="w-32">
                  <Input
                    type="number"
                    aria-label={t('hr.warningGoalSalary')}
                    value={g.salary}
                    onChange={(e) =>
                      setGoals((prev) => prev.map((x, j) => (j === i ? { ...x, salary: e.target.value } : x)))
                    }
                    className="text-right tabular-nums"
                  />
                </div>
                <span aria-hidden className="text-[13px] text-text-3">→</span>
                <div className="w-36">
                  <Input
                    type="number"
                    aria-label={t('hr.warningGoalMin')}
                    value={g.min_net_deposit}
                    onChange={(e) =>
                      setGoals((prev) => prev.map((x, j) => (j === i ? { ...x, min_net_deposit: e.target.value } : x)))
                    }
                    className="text-right tabular-nums"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setGoals((prev) => prev.filter((_, j) => j !== i))}
                  className={ROW_DANGER_CLASS}
                  aria-label={t('common.delete')}
                >
                  <X aria-hidden className="size-4" />
                </button>
              </div>
            ))}
          </div>
        </Panel>
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
      {/* Requieren que alguien las firme: `pend`. Antes un recuadro ámbar
          (`bg-warning/5`) que no decía cuántas quedaban por firmar. */}
      <Panel
        title={t('hr.warningSuggestions')}
        hint={t('hr.warningSuggestionsHint')}
        actions={
          suggestions.length > 0 ? (
            <StatusBadge kind="pend" label={t('hrv.toConfirm', { n: String(suggestions.length) })} />
          ) : undefined
        }
        flush
      >
        {loading ? (
          <p className="px-4 py-3 text-[13px] text-text-3">{t('common.loading')}</p>
        ) : loadError ? (
          <div className="p-4">
            <Notice kind="bad" title={t('hr.warningError')} />
          </div>
        ) : (
          <FinTable
            columns={suggestionColumns}
            rows={suggestions}
            rowKey={(s2) => s2.profileId}
            caption={t('hr.warningSuggestions')}
            empty={t('hr.warningNoSuggestions')}
            rowActions={(s2) => (
              <ActionButton
               
                onClick={() => createWarning(s2.profileId, 'net_deposit', t('hr.warningAutoDetail'))}
                loading={busyId === `${s2.profileId}:net_deposit`}
              >
                <Check aria-hidden className="size-3.5" /> {t('hr.warningConfirm')}
              </ActionButton>
            )}
          />
        )}
      </Panel>

      {/* ── Warnings cargados ───────────────────────────────────────────── */}
      <Panel title={t('hr.warningsOfMonth')} hint={`${t('hr.warningRepeatOffenders')}: ${repeatOffenders}`} flush>
        {loadError ? (
          <div className="p-4">
            <Notice kind="bad" title={t('hr.warningError')} />
          </div>
        ) : loading ? (
          <p className="px-4 py-3 text-[13px] text-text-3">{t('common.loading')}</p>
        ) : (
          <FinTable
            columns={warningColumns}
            rows={warnings}
            rowKey={(w) => w.id}
            caption={t('hr.warningsOfMonth')}
            empty={t('hr.warningNone')}
            rowActions={(w) => (
              <button
                type="button"
                onClick={() => deleteWarning(w.id)}
                disabled={busyId === w.id}
                className={ROW_DANGER_CLASS}
                aria-label={t('common.delete')}
                title={t('common.delete')}
              >
                <Trash2 aria-hidden className="size-[15px]" strokeWidth={1.75} />
              </button>
            )}
          />
        )}
      </Panel>
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
    <Panel
      title={t('hr.warningNew')}
      footer={
        <span className="flex flex-wrap items-center gap-2">
          <ActionButton
            variant="primary"
            onClick={async () => {
              if (!profileId) return;
              setSaving(true);
              await onSave(profileId, motive, detail.trim() || undefined);
              setSaving(false);
            }}
            disabled={!profileId}
            loading={saving}
          >
            {saving ? t('hr.saving') : t('common.save')}
          </ActionButton>
          <ActionButton variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </ActionButton>
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t('hr.warningProfile')} required>
          <Select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">—</option>
            {sorted.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {hrRoleLabel(p.role)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('hr.warningMotive')}>
          <Select value={motive} onChange={(e) => setMotive(e.target.value as WarningMotive)}>
            {WARNING_MOTIVES.map((m) => (
              <option key={m} value={m}>
                {t(MOTIVE_LABEL_KEY[m])}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('hr.warningDetail')}>
          <Input type="text" value={detail} onChange={(e) => setDetail(e.target.value)} />
        </Field>
      </div>
    </Panel>
  );
}
