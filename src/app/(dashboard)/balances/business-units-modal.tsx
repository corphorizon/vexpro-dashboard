'use client';

// ─────────────────────────────────────────────────────────────────────────────
// BusinessUnitsModal — alta / edición / baja de unidades de negocio.
//
// El switch "suma al fondo" es la decisión de negocio del módulo: marca si el
// saldo de esa unidad forma parte del ahorro real de la empresa o se lleva
// aparte. Vive acá y no en cada ubicación (ver migración 070).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRightLeft, Plus, RefreshCw, Save, ToggleLeft, ToggleRight, Trash2, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import type { BusinessUnit } from '@/lib/cash-locations';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Se llama tras cada mutación para que la pantalla recargue el desglose. */
  onChanged: () => void;
}

interface Draft {
  name: string;
  counts_to_fund: boolean;
}

export function BusinessUnitsModal({ open, onClose, onChanged }: Props) {
  const { t } = useI18n();
  const [units, setUnits] = useState<BusinessUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [newName, setNewName] = useState('');
  const [newCountsToFund, setNewCountsToFund] = useState(true);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/business-units?include_inactive=1');
      const json = (await res.json()) as { success: boolean; units?: BusinessUnit[]; error?: string };
      if (!json.success) throw new Error(json.error ?? t('cash.unitsLoadError'));
      setUnits(json.units ?? []);
      setDrafts({});
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : t('cash.unitsLoadError') });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setNewName('');
    setNewCountsToFund(true);
    load();
  }, [open, load]);

  if (!open) return null;

  const draftOf = (u: BusinessUnit): Draft =>
    drafts[u.id] ?? { name: u.name, counts_to_fund: u.counts_to_fund };

  const setDraft = (u: BusinessUnit, patch: Partial<Draft>) =>
    setDrafts((prev) => ({ ...prev, [u.id]: { ...draftOf(u), ...patch } }));

  const save = async (u: BusinessUnit) => {
    const draft = draftOf(u);
    setSavingId(u.id);
    setStatus(null);
    try {
      const res = await apiFetch('/api/admin/business-units', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: u.id,
          name: draft.name,
          counts_to_fund: draft.counts_to_fund,
          is_active: u.is_active,
          sort_order: u.sort_order,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? t('cash.unitSaveError'));
      setStatus({ kind: 'ok', msg: t('cash.unitSaved') });
      await load();
      onChanged();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : t('cash.unitSaveError') });
    } finally {
      setSavingId(null);
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setStatus(null);
    try {
      const res = await apiFetch('/api/admin/business-units', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          counts_to_fund: newCountsToFund,
          sort_order: units.length,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? t('cash.unitSaveError'));
      setNewName('');
      setNewCountsToFund(true);
      setStatus({ kind: 'ok', msg: t('cash.unitSaved') });
      await load();
      onChanged();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : t('cash.unitSaveError') });
    } finally {
      setCreating(false);
    }
  };

  const remove = async (u: BusinessUnit) => {
    if (!window.confirm(t('cash.deleteUnitConfirm', { name: u.name }))) return;
    setSavingId(u.id);
    setStatus(null);
    try {
      const res = await apiFetch(`/api/admin/business-units?id=${encodeURIComponent(u.id)}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? t('cash.unitDeleteError'));
      setStatus({ kind: 'ok', msg: t('cash.unitDeleted') });
      await load();
      onChanged();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : t('cash.unitDeleteError') });
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-card border border-border rounded-xl shadow-lg w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('cash.manageUnits')}
      >
        <div className="flex items-center justify-between gap-3 p-5 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t('cash.manageUnits')}</h2>
            <p className="text-xs text-muted-foreground">{t('cash.manageUnitsHint')}</p>
          </div>
          <button
            onClick={onClose}
            className="min-h-11 min-w-11 flex items-center justify-center rounded-lg hover:bg-muted"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {status && (
            <div
              className={`p-3 rounded-lg text-sm border ${
                status.kind === 'ok'
                  ? 'bg-positive/10 border-positive/30 text-positive'
                  : 'bg-negative/10 border-negative/30 text-negative'
              }`}
            >
              {status.msg}
            </div>
          )}

          {loading ? (
            <p className="text-center text-muted-foreground py-8">{t('common.loading')}</p>
          ) : units.length === 0 ? (
            <p className="text-center text-muted-foreground py-6">{t('cash.noUnits')}</p>
          ) : (
            <div className="space-y-2">
              {units.map((u) => {
                const draft = draftOf(u);
                const dirty = draft.name !== u.name || draft.counts_to_fund !== u.counts_to_fund;
                return (
                  <div
                    key={u.id}
                    className="flex flex-col sm:flex-row sm:items-center gap-2 p-3 rounded-lg border border-border"
                  >
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft(u, { name: e.target.value })}
                      className="flex-1 min-w-0 h-11 sm:h-9 px-3 text-base sm:text-sm rounded-lg border border-border bg-card focus:outline-none focus:ring-2 focus:ring-accent/30"
                      aria-label={t('cash.unitName')}
                    />
                    <button
                      onClick={() => setDraft(u, { counts_to_fund: !draft.counts_to_fund })}
                      className="inline-flex items-center gap-2 min-h-11 sm:min-h-9 px-2 rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors"
                      title={t('cash.countsToFundHint')}
                    >
                      {draft.counts_to_fund ? (
                        <ToggleRight className="w-6 h-6 text-positive" />
                      ) : (
                        <ToggleLeft className="w-6 h-6" />
                      )}
                      <span className="whitespace-nowrap">{t('cash.countsToFund')}</span>
                    </button>
                    <div className="flex items-center gap-1">
                      {/* Segunda puerta al libro consolidado: desde acá también
                          se llega, sin tener que volver a la tarjeta. */}
                      <Link
                        href={`/balances/unidad/${encodeURIComponent(u.id)}`}
                        className="inline-flex items-center gap-1.5 min-h-11 sm:min-h-9 px-3 text-xs rounded-lg border border-border hover:bg-muted transition-colors whitespace-nowrap"
                        title={t('unitLedger.openBook')}
                      >
                        <ArrowRightLeft className="w-3.5 h-3.5" />
                        {t('cash.viewMovements')}
                      </Link>
                      <button
                        onClick={() => save(u)}
                        disabled={!dirty || savingId === u.id}
                        className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 flex items-center justify-center rounded-lg text-positive hover:bg-positive/10 disabled:opacity-40"
                        aria-label={t('common.save')}
                      >
                        {savingId === u.id ? (
                          <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                          <Save className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        onClick={() => remove(u)}
                        disabled={savingId === u.id}
                        className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 flex items-center justify-center rounded-lg text-negative hover:bg-negative/10 disabled:opacity-40"
                        aria-label={t('common.delete')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="pt-4 border-t border-border space-y-2">
            <p className="text-sm font-medium">{t('cash.newUnit')}</p>
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('cash.unitNamePlaceholder')}
                className="flex-1 min-w-0 h-11 sm:h-9 px-3 text-base sm:text-sm rounded-lg border border-border bg-card focus:outline-none focus:ring-2 focus:ring-accent/30"
                aria-label={t('cash.unitName')}
              />
              <button
                onClick={() => setNewCountsToFund((v) => !v)}
                className="inline-flex items-center gap-2 min-h-11 sm:min-h-9 px-2 rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors"
                title={t('cash.countsToFundHint')}
              >
                {newCountsToFund ? (
                  <ToggleRight className="w-6 h-6 text-positive" />
                ) : (
                  <ToggleLeft className="w-6 h-6" />
                )}
                <span className="whitespace-nowrap">{t('cash.countsToFund')}</span>
              </button>
              <button
                onClick={create}
                disabled={!newName.trim() || creating}
                className="inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-9 px-4 rounded-lg bg-primary text-white text-sm font-medium hover:opacity-90 disabled:opacity-40"
              >
                {creating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {t('cash.addUnit')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
