'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Search, CheckCircle2, AlertCircle, X } from 'lucide-react';
import type { CommercialProfile } from '@/lib/types';
import { apiFetch } from '@/lib/api-fetch';

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
const BOOL_COLS: { key: BoolKey; label: string }[] = [
  { key: 'propuesta', label: 'Propuesta' },
  { key: 'acepto_propuesta', label: 'Acepto' },
  { key: 'contrato', label: 'Contrato' },
  { key: 'acepto_contrato', label: 'Acepto' },
  { key: 'accesos', label: 'Accesos' },
];

const emptyRow = (profile_id: string): ChecklistRow => ({
  profile_id,
  propuesta: false, acepto_propuesta: false, contrato: false,
  acepto_contrato: false, accesos: false, salario_fijo: null, sponsor: null,
});

function isFired(p: CommercialProfile) {
  return p.status === 'inactive' && !!p.termination_date;
}

export function OnboardingTab({ profiles }: { profiles: CommercialProfile[] }) {
  const [rows, setRows] = useState<Map<string, ChecklistRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // Sponsor por defecto = nombre del HEAD del perfil.
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of profiles) m.set(p.id, p.name);
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
      setToast({ type: 'error', msg: 'No se pudo guardar. ¿Ya corriste la migración en la base?' });
    }
  }, []);

  const toggle = useCallback((profileId: string, key: BoolKey) => {
    const r = getRow(profileId);
    save({ ...r, [key]: !r[key] });
  }, [getRow, save]);

  // ─── Auto-dismiss toast ───
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const completedCount = useMemo(() => {
    let done = 0;
    for (const p of sorted) {
      const r = getRow(p.id);
      if (BOOL_COLS.every((c) => r[c.key])) done++;
    }
    return done;
  }, [sorted, getRow]);

  return (
    <div className="space-y-4">
      {toast && (
        <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm ${toast.type === 'error' ? 'bg-negative/10 text-negative' : 'bg-positive/10 text-positive'}`}>
          {toast.type === 'error' ? <AlertCircle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          <span className="flex-1">{toast.msg}</span>
          <button onClick={() => setToast(null)} aria-label="Cerrar"><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Check List Onboarding</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {completedCount} de {sorted.length} con el proceso completo · marca cada paso y se guarda solo.
          </p>
        </div>
        <div className="relative flex-1 sm:w-64 sm:max-w-xs">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            aria-label="Buscar comercial"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nombre o email..."
            className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-border bg-card text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
          />
        </div>
      </div>

      {loadError && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm bg-warning/10 text-warning">
          <AlertCircle className="w-4 h-4" />
          No se pudo cargar el checklist. Verifica que la tabla <code>onboarding_checklist</code> exista en la base.
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Cargando checklist…</div>
      ) : (
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left py-2.5 px-3 text-muted-foreground font-medium sticky left-0 bg-muted/50 min-w-[200px]">Nombre</th>
                {BOOL_COLS.map((c, i) => (
                  <th key={`${c.key}-${i}`} className="text-center py-2.5 px-2 text-muted-foreground font-medium whitespace-nowrap">{c.label}</th>
                ))}
                <th className="text-right py-2.5 px-3 text-muted-foreground font-medium whitespace-nowrap min-w-[120px]">Salario Fijo</th>
                <th className="text-left py-2.5 px-3 text-muted-foreground font-medium whitespace-nowrap min-w-[160px]">Sponsor</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const r = getRow(p.id);
                const complete = BOOL_COLS.every((c) => r[c.key]);
                const fired = isFired(p);
                const salarioDefault = p.salary ?? null;
                const sponsorDefault = p.head_id ? (nameById.get(p.head_id) ?? '') : '';
                const salarioVal = r.salario_fijo ?? salarioDefault ?? '';
                const sponsorVal = r.sponsor ?? sponsorDefault;
                return (
                  <tr key={p.id} className={`border-b border-border last:border-0 ${complete ? 'bg-positive/5' : ''}`}>
                    <td className="py-2 px-3 sticky left-0 bg-card">
                      <div className={`font-medium ${fired ? 'line-through text-muted-foreground' : ''}`}>
                        {p.name}
                        {fired && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground no-underline">despedido</span>}
                      </div>
                      <div className="text-xs text-muted-foreground">{p.email}</div>
                    </td>
                    {BOOL_COLS.map((c, i) => (
                      <td key={`${c.key}-${i}`} className="text-center py-2 px-2">
                        <input
                          type="checkbox"
                          aria-label={`${c.label} — ${p.name}`}
                          checked={r[c.key]}
                          onChange={() => toggle(p.id, c.key)}
                          className="w-4 h-4 rounded border-border accent-[var(--color-primary)] cursor-pointer"
                        />
                      </td>
                    ))}
                    <td className="py-2 px-3 text-right">
                      <input
                        key={`sal-${p.id}`}
                        type="number"
                        step="0.01"
                        defaultValue={salarioVal === '' ? '' : String(salarioVal)}
                        aria-label={`Salario fijo — ${p.name}`}
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          const parsed = raw === '' ? null : Number(raw);
                          const override = (parsed === null || Number.isNaN(parsed) || parsed === salarioDefault) ? null : parsed;
                          if (override !== (r.salario_fijo ?? null)) save({ ...r, salario_fijo: override });
                        }}
                        className="w-24 px-2 py-1 rounded border border-border bg-card text-sm text-right focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                      />
                    </td>
                    <td className="py-2 px-3">
                      <input
                        key={`spo-${p.id}`}
                        type="text"
                        defaultValue={sponsorVal}
                        aria-label={`Sponsor — ${p.name}`}
                        placeholder="—"
                        onBlur={(e) => {
                          const raw = e.target.value.trim();
                          const override = (raw === '' || raw === sponsorDefault) ? null : raw;
                          if (override !== (r.sponsor ?? null)) save({ ...r, sponsor: override });
                        }}
                        className="w-40 px-2 py-1 rounded border border-border bg-card text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
                      />
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={BOOL_COLS.length + 3} className="py-10 text-center text-sm text-muted-foreground">Sin resultados.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
