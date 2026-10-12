'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { CommercialProfile } from '@/lib/types';
import { apiFetch } from '@/lib/api-fetch';
import { estaDespedido } from '@/lib/hr/domain';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { StatusBadge } from '@/components/ui/status-badge';
import { CONTROL_CLASS } from '@/components/ui/field';
import { useToasts } from '@/components/ui/toast';
import { CHECKBOX_CLASS, SearchField } from './hr-ui';

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña ONBOARDING — el checklist del Excel «Proceso de contratación».
//
// «Libro mayor» (2026-10-12) — sólo presentación; el guardado optimista y el
// POST no cambiaron:
//   · Panel + FinTable. La fila completa se pintaba entera de verde
//     (`bg-positive/5`): ahora una columna «Progreso» con «5/5» en
//     StatusBadge `ok` (completo) o neutro — el color dice algo de UNA celda,
//     no tiñe la fila.
//   · En < 720 px cada persona es una tarjeta y el checklist (y salario /
//     sponsor) baja bajo el nombre (`mobileMeta`): antes la tabla tenía 8
//     columnas con scroll horizontal y la columna de nombre sticky.
//   · El error de carga es un Notice `bad` (antes `bg-warning/10 text-warning`:
//     color de «pendiente» para algo que falló).
//   · El toast de error de guardado va al toast flotante.
// Medición (sin comentarios): antes 1 `text-[10px]` y 21 tokens legados;
// después 0.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Tipos locales ─────────────────────────────────────────────────────────
type ChecklistRow = {
  profile_id: string;
  propuesta: boolean;
  acepto_propuesta: boolean;
  contrato: boolean;
  acepto_contrato: boolean;
  accesos: boolean;
  salario_fijo: number | null;
  sponsor: string | null;
};

type BoolKey = 'propuesta' | 'acepto_propuesta' | 'contrato' | 'acepto_contrato' | 'accesos';

// Columnas del checklist tal cual el Excel de "Proceso de contratación".
const BOOL_COLS: { key: BoolKey; labelKey: string }[] = [
  { key: 'propuesta', labelKey: 'onboarding.colProposal' },
  { key: 'acepto_propuesta', labelKey: 'onboarding.colAccepted' },
  { key: 'contrato', labelKey: 'onboarding.colContract' },
  { key: 'acepto_contrato', labelKey: 'onboarding.colAccepted' },
  { key: 'accesos', labelKey: 'onboarding.colAccess' },
];

const emptyRow = (profile_id: string): ChecklistRow => ({
  profile_id,
  propuesta: false, acepto_propuesta: false, contrato: false,
  acepto_contrato: false, accesos: false, salario_fijo: null, sponsor: null,
});

/** Input chico de celda (salario / sponsor): receta de control, alto 32. */
const CELL_INPUT = cn(CONTROL_CLASS, 'h-8 border-control-border');

export function OnboardingTab({ profiles }: { profiles: CommercialProfile[] }) {
  const { t } = useI18n();
  const [rows, setRows] = useState<Map<string, ChecklistRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const { toast, ToastHost } = useToasts();

  // Sponsor por defecto = email del HEAD del perfil.
  const emailById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of profiles) m.set(p.id, p.email);
    return m;
  }, [profiles]);

  // Fuerza Comercial ordenada por nombre.
  const sorted = useMemo(
    () => [...profiles].sort((a, b) => a.name.localeCompare(b.name)),
    [profiles],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q),
    );
  }, [sorted, search]);

  // ─── Cargar checklist ───
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const res = await apiFetch('/api/admin/onboarding-checklist');
        const json = await res.json();
        if (!alive) return;
        if (!res.ok || !json.success) throw new Error(json.error || 'load failed');
        const m = new Map<string, ChecklistRow>();
        for (const r of json.rows ?? []) m.set(r.profile_id, r as ChecklistRow);
        setRows(m);
      } catch {
        if (alive) setLoadError(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const getRow = useCallback(
    (profileId: string): ChecklistRow => rows.get(profileId) ?? emptyRow(profileId),
    [rows],
  );

  // ─── Guardar (optimista + POST) ───
  const save = useCallback(async (row: ChecklistRow) => {
    setRows((prev) => new Map(prev).set(row.profile_id, row));
    try {
      const res = await apiFetch('/api/admin/onboarding-checklist', {
        method: 'POST',
        body: JSON.stringify(row),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || 'save failed');
    } catch {
      toast.error(t('onboarding.saveError'));
    }
  }, [t, toast]);

  const toggle = useCallback((profileId: string, key: BoolKey) => {
    const r = getRow(profileId);
    save({ ...r, [key]: !r[key] });
  }, [getRow, save]);

  const doneCount = (r: ChecklistRow) => BOOL_COLS.filter((c) => r[c.key]).length;

  const completedCount = useMemo(() => {
    let done = 0;
    for (const p of sorted) {
      const r = getRow(p.id);
      if (BOOL_COLS.every((c) => r[c.key])) done++;
    }
    return done;
  }, [sorted, getRow]);

  const checkbox = (p: CommercialProfile, c: (typeof BOOL_COLS)[number]) => (
    <input
      type="checkbox"
      aria-label={`${t(c.labelKey)} — ${p.name}`}
      checked={getRow(p.id)[c.key]}
      onChange={() => toggle(p.id, c.key)}
      className={CHECKBOX_CLASS}
    />
  );

  const salaryInput = (p: CommercialProfile) => {
    const r = getRow(p.id);
    const salarioDefault = p.salary ?? null;
    const salarioVal = r.salario_fijo ?? salarioDefault ?? '';
    return (
      <input
        key={`sal-${p.id}`}
        type="number"
        step="0.01"
        defaultValue={salarioVal === '' ? '' : String(salarioVal)}
        aria-label={`${t('onboarding.colFixedSalary')} — ${p.name}`}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          const parsed = raw === '' ? null : Number(raw);
          const override = (parsed === null || Number.isNaN(parsed) || parsed === salarioDefault) ? null : parsed;
          if (override !== (r.salario_fijo ?? null)) save({ ...r, salario_fijo: override });
        }}
        className={cn(CELL_INPUT, 'w-24 text-right tabular-nums')}
      />
    );
  };

  const sponsorInput = (p: CommercialProfile) => {
    const r = getRow(p.id);
    const sponsorDefault = p.head_id ? (emailById.get(p.head_id) ?? '') : '';
    const sponsorVal = r.sponsor ?? sponsorDefault;
    return (
      <input
        key={`spo-${p.id}`}
        type="text"
        defaultValue={sponsorVal}
        aria-label={`${t('onboarding.colSponsor')} — ${p.name}`}
        placeholder="—"
        onBlur={(e) => {
          const raw = e.target.value.trim();
          const override = (raw === '' || raw === sponsorDefault) ? null : raw;
          if (override !== (r.sponsor ?? null)) save({ ...r, sponsor: override });
        }}
        className={cn(CELL_INPUT, 'w-40')}
      />
    );
  };

  const progressBadge = (p: CommercialProfile) => {
    const n = doneCount(getRow(p.id));
    return (
      <StatusBadge
        kind={n === BOOL_COLS.length ? 'ok' : 'neutral'}
        label={`${n}/${BOOL_COLS.length}`}
      />
    );
  };

  const columns: FinColumn<CommercialProfile>[] = [
    {
      key: 'name',
      header: t('common.name'),
      cell: (p) => {
        const fired = estaDespedido(p);
        return (
          <span className="inline-flex items-center gap-1.5">
            <span className={cn(fired && 'text-text-3 line-through')}>{p.name}</span>
            {fired && <StatusBadge kind="neutral" label={t('onboarding.firedBadge')} />}
          </span>
        );
      },
      meta: (p) => p.email,
      // En la tarjeta móvil el checklist entero baja bajo el nombre.
      mobileMeta: (p) => (
        <span className="flex flex-col gap-2">
          <span className="flex flex-wrap gap-x-3 gap-y-1.5">
            {BOOL_COLS.map((c, i) => (
              <label key={`${c.key}-${i}`} className="inline-flex items-center gap-1.5 text-[12px] text-text-2">
                {checkbox(p, c)}
                {t(c.labelKey)}
              </label>
            ))}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            {salaryInput(p)}
            {sponsorInput(p)}
          </span>
        </span>
      ),
    },
    ...BOOL_COLS.map((c, i): FinColumn<CommercialProfile> => ({
      key: `${c.key}-${i}`,
      header: t(c.labelKey),
      align: 'center',
      hideSm: true,
      cell: (p) => checkbox(p, c),
    })),
    {
      key: 'progress',
      header: t('hrv.progress'),
      align: 'center',
      cardSide: 'right',
      cell: progressBadge,
    },
    { key: 'salary', header: t('onboarding.colFixedSalary'), align: 'right', hideSm: true, cell: salaryInput },
    { key: 'sponsor', header: t('onboarding.colSponsor'), hideSm: true, cell: sponsorInput },
  ];

  return (
    <div className="space-y-4">
      {ToastHost}

      {loadError && (
        <Notice kind="bad" title={`${t('onboarding.loadErrorPre')} onboarding_checklist ${t('onboarding.loadErrorPost')}`} />
      )}

      <Panel
        title={t('onboarding.title')}
        hint={t('onboarding.progress', { done: String(completedCount), total: String(sorted.length) })}
        actions={
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder={t('onboarding.searchPlaceholder')}
            ariaLabel={t('onboarding.searchAriaLabel')}
            className="w-64"
          />
        }
        flush
        footer={
          filtered.length < sorted.length
            ? t('hrv.rowsShowing', { shown: String(filtered.length), total: String(sorted.length) })
            : undefined
        }
      >
        {loading ? (
          <p className="px-4 py-12 text-center text-[13px] text-text-3">{t('onboarding.loading')}</p>
        ) : (
          <FinTable
            columns={columns}
            rows={filtered}
            rowKey={(p) => p.id}
            caption={t('onboarding.title')}
            empty={t('onboarding.noResults')}
          />
        )}
      </Panel>
    </div>
  );
}
