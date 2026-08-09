'use client';

// ─────────────────────────────────────────────────────────────────────────────
// CashLocationsCard — "dónde está la plata y de qué unidad es".
//
// Vive dentro de la misma pantalla de Balances (pedido explícito de Kevin: una
// sola pantalla). No inventa saldos: reusa el mismo `getChannelValue` que la
// tarjeta de canales, así que ambas siempre muestran el mismo número.
//
// La clasificación (tipo / unidad / holder) se guarda en channel_configs vía
// el upsert que ya existía; el saldo NO se toca desde acá — el de una pasarela
// lo sincroniza su API y el del resto sale de su libro.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Banknote,
  BookOpen,
  Building2,
  Check,
  HandCoins,
  Pencil,
  RefreshCw,
  Wallet,
  X,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { apiFetch } from '@/lib/api-fetch';
import { useI18n } from '@/lib/i18n';
import { formatCurrency } from '@/lib/utils';
import { hasLedger, isAutoLedger } from '@/lib/channel-ledger';
import type { ChannelConfigRow, ResolvedChannel } from '@/lib/channel-configs';
import {
  DEFAULT_LOCATION_TYPE,
  LOCATION_TYPES,
  LOCATION_TYPE_LABELS,
  groupByType,
  groupByUnit,
  isAutomatic,
  isLiquid,
  normalizeLocationType,
  summarize,
  type BusinessUnit,
  type CashLocation,
  type LocationType,
} from '@/lib/cash-locations';
import { BusinessUnitsModal } from './business-units-modal';

interface Props {
  /** Canales visibles ya resueltos por la pantalla (built-ins + custom). */
  channels: ResolvedChannel[];
  /** Filas crudas de channel_configs — de acá salen tipo, unidad y holder. */
  configRows: ChannelConfigRow[];
  /** Mismo saldo que muestra la tarjeta de canales, para no divergir. */
  getValue: (channelKey: string) => number;
  /** Recarga la config de canales en el padre tras guardar. */
  onChanged: () => void;
  canManage: boolean;
}

interface Draft {
  location_type: LocationType;
  business_unit_id: string;
  holder: string;
}

export function CashLocationsCard({ channels, configRows, getValue, onChanged, canManage }: Props) {
  const { t, locale } = useI18n();
  const lang = locale === 'en' ? 'en' : 'es';

  const [units, setUnits] = useState<BusinessUnit[]>([]);
  const [showUnits, setShowUnits] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const loadUnits = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/business-units');
      const json = (await res.json()) as { success: boolean; units?: BusinessUnit[] };
      if (json.success) setUnits(json.units ?? []);
    } catch {
      // Sin unidades el desglose sigue funcionando: todo cae en "sin asignar".
    }
  }, []);

  useEffect(() => {
    loadUnits();
  }, [loadUnits]);

  const locations: CashLocation[] = useMemo(() => {
    const rowByKey = new Map(configRows.map((r) => [r.channel_key, r]));
    return channels.map((ch) => {
      const row = rowByKey.get(ch.key);
      return {
        channel_key: ch.key,
        label: ch.label,
        // Sin fila guardada, una pasarela con API es 'gateway' y el resto cae
        // al default del catálogo — nunca se inventa una lista nueva de keys.
        location_type: row?.location_type
          ? normalizeLocationType(row.location_type)
          : isAutoLedger(ch.key)
            ? 'gateway'
            : DEFAULT_LOCATION_TYPE,
        business_unit_id: row?.business_unit_id ?? null,
        holder: row?.holder ?? null,
        is_visible: ch.isVisible,
        sort_order: ch.sortOrder,
        balance: getValue(ch.key),
      };
    });
  }, [channels, configRows, getValue]);

  const summary = useMemo(() => summarize(locations, units), [locations, units]);
  const byUnit = useMemo(() => groupByUnit(locations, units), [locations, units]);
  const byType = useMemo(() => groupByType(locations), [locations]);

  const startEdit = (loc: CashLocation) => {
    setStatus(null);
    setEditingKey(loc.channel_key);
    setDraft({
      location_type: loc.location_type,
      business_unit_id: loc.business_unit_id ?? '',
      holder: loc.holder ?? '',
    });
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setDraft(null);
  };

  const saveEdit = async (loc: CashLocation) => {
    if (!draft) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await apiFetch('/api/admin/channel-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          channel_key: loc.channel_key,
          // El upsert no puede omitir is_visible: su default es `true` y
          // omitirlo re-mostraría una ubicación que el admin había ocultado.
          is_visible: loc.is_visible,
          location_type: draft.location_type,
          business_unit_id: draft.business_unit_id || null,
          holder: draft.holder,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? t('cash.saveError'));
      cancelEdit();
      setStatus({ kind: 'ok', msg: t('cash.saved') });
      onChanged();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : t('cash.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const typeLabel = (type: LocationType) => LOCATION_TYPE_LABELS[type][lang];

  return (
    <Card>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-accent/10">
            <Banknote className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">{t('cash.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('cash.subtitle')}</p>
          </div>
        </div>
        {canManage && (
          <button
            onClick={() => setShowUnits(true)}
            className="inline-flex items-center gap-1.5 min-h-11 sm:min-h-9 px-3 text-sm rounded-lg border border-border bg-card hover:bg-muted transition-colors"
          >
            <Building2 className="w-4 h-4" />
            {t('cash.manageUnits')}
          </button>
        )}
      </div>

      {status && (
        <div
          className={`mb-4 p-3 rounded-lg text-sm border ${
            status.kind === 'ok'
              ? 'bg-positive/10 border-positive/30 text-positive'
              : 'bg-negative/10 border-negative/30 text-negative'
          }`}
        >
          {status.msg}
        </div>
      )}

      {/* Resumen. Disponible y Prestado van primero y separados a propósito:
          confundirlos es creer que hay caja para pagar algo que no está. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="p-4 rounded-lg border border-positive/30 bg-positive/5">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('cash.available')}</p>
          <p className="text-2xl font-bold text-positive tabular-nums">{formatCurrency(summary.liquid)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{t('cash.availableHint')}</p>
        </div>
        <div className="p-4 rounded-lg border border-warning/30 bg-warning/5">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('cash.lent')}</p>
          <p className="text-2xl font-bold text-warning tabular-nums">{formatCurrency(summary.lent)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{t('cash.lentHint')}</p>
        </div>
        <div className="p-4 rounded-lg border border-border">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('cash.total')}</p>
          <p className="text-2xl font-bold tabular-nums">{formatCurrency(summary.total)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{t('cash.totalHint')}</p>
        </div>
        <div className="p-4 rounded-lg border border-border bg-muted/30">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('cash.fund')}</p>
          <p className="text-2xl font-bold tabular-nums">{formatCurrency(summary.fund)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {t('cash.outsideFund')}: {formatCurrency(summary.outsideFund)}
          </p>
        </div>
      </div>

      {summary.lent !== 0 && (
        <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <HandCoins className="w-4 h-4 shrink-0 text-warning" />
          <span>{t('cash.lentNotice')}</span>
        </p>
      )}

      {/* Ubicaciones agrupadas por unidad de negocio */}
      <div className="mt-6 space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t('cash.byUnit')}
        </h3>

        {byUnit.map((group) => (
          <div key={group.unit?.id ?? 'unassigned'} className="rounded-lg border border-border overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-3 py-2 bg-muted/40">
              <div className="flex items-center gap-2 min-w-0">
                <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                <p className="font-medium truncate">{group.unit?.name ?? t('cash.noUnit')}</p>
                <span
                  className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                    group.unit && !group.unit.counts_to_fund
                      ? 'bg-muted text-muted-foreground border-border'
                      : 'bg-positive/10 text-positive border-positive/30'
                  }`}
                >
                  {group.unit && !group.unit.counts_to_fund ? t('cash.apartFromFund') : t('cash.inFund')}
                </span>
              </div>
              <span className="font-semibold tabular-nums shrink-0">{formatCurrency(group.total)}</span>
            </div>

            <div className="divide-y divide-border">
              {group.locations.map((loc) => {
                const editing = editingKey === loc.channel_key;
                const automatic = isAutomatic(loc.location_type);
                return (
                  <div key={loc.channel_key} className="p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Wallet className="w-4 h-4 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <p className="font-medium truncate">{loc.label}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {typeLabel(loc.location_type)}
                            {loc.holder ? ` · ${loc.holder}` : ''}
                            {automatic ? ` · ${t('cash.autoSynced')}` : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span
                          className={`font-semibold tabular-nums ${
                            isLiquid(loc.location_type) ? '' : 'text-warning'
                          }`}
                        >
                          {formatCurrency(loc.balance)}
                        </span>
                        {hasLedger(loc.channel_key) && (
                          <Link
                            href={`/balances/libro/${encodeURIComponent(loc.channel_key)}`}
                            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 flex items-center justify-center rounded-lg text-accent hover:bg-accent/10"
                            title={t('ledger.openBook')}
                            aria-label={`${t('ledger.openBook')} — ${loc.label}`}
                          >
                            <BookOpen className="w-4 h-4" />
                          </Link>
                        )}
                        {canManage && !editing && (
                          <button
                            onClick={() => startEdit(loc)}
                            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 flex items-center justify-center rounded-lg text-accent hover:bg-accent/10"
                            title={t('cash.editLocation')}
                            aria-label={`${t('cash.editLocation')} — ${loc.label}`}
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    {editing && draft && (
                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {t('cash.locationType')}
                          <select
                            value={draft.location_type}
                            onChange={(e) =>
                              setDraft({ ...draft, location_type: e.target.value as LocationType })
                            }
                            className="h-11 sm:h-9 px-3 text-base sm:text-sm rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                          >
                            {LOCATION_TYPES.map((type) => (
                              <option key={type} value={type}>
                                {typeLabel(type)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {t('cash.businessUnit')}
                          <select
                            value={draft.business_unit_id}
                            onChange={(e) => setDraft({ ...draft, business_unit_id: e.target.value })}
                            className="h-11 sm:h-9 px-3 text-base sm:text-sm rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                          >
                            <option value="">{t('cash.noUnit')}</option>
                            {units.map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {t('cash.holder')}
                          <input
                            value={draft.holder}
                            onChange={(e) => setDraft({ ...draft, holder: e.target.value })}
                            placeholder={t('cash.holderPlaceholder')}
                            className="h-11 sm:h-9 px-3 text-base sm:text-sm rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30"
                          />
                        </label>
                        <div className="sm:col-span-3 flex items-center justify-between gap-2">
                          <p className="text-[11px] text-muted-foreground">
                            {automatic ? t('cash.autoBalanceNote') : t('cash.manualBalanceNote')}
                          </p>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => saveEdit(loc)}
                              disabled={saving}
                              className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 flex items-center justify-center rounded-lg text-positive hover:bg-positive/10 disabled:opacity-40"
                              aria-label={t('common.save')}
                            >
                              {saving ? (
                                <RefreshCw className="w-4 h-4 animate-spin" />
                              ) : (
                                <Check className="w-4 h-4" />
                              )}
                            </button>
                            <button
                              onClick={cancelEdit}
                              className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
                              aria-label={t('common.cancel')}
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Desglose por tipo */}
      {byType.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            {t('cash.byType')}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {byType.map((row) => (
              <div key={row.type} className="p-3 rounded-lg border border-border">
                <p className="text-xs text-muted-foreground truncate">{typeLabel(row.type)}</p>
                <p
                  className={`text-base font-semibold tabular-nums ${
                    isLiquid(row.type) ? '' : 'text-warning'
                  }`}
                >
                  {formatCurrency(row.total)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {t('cash.locationCount', { count: String(row.count) })}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {canManage && (
        <BusinessUnitsModal
          open={showUnits}
          onClose={() => setShowUnits(false)}
          onChanged={() => {
            loadUnits();
            onChanged();
          }}
        />
      )}
    </Card>
  );
}
