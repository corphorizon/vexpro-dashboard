'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChannelBalancesCard — "Balances por Canal": cuánto hay, dónde está y de quién
// es, en una sola tarjeta.
//
// Antes eran dos que mostraban los mismos saldos con distinta cara ("Balances
// por Canal" y "Dónde está el dinero"): el mismo número en dos lugares invita a
// que uno de los dos quede desactualizado y a que nadie sepa cuál mirar.
//
// De la vieja quedaron la fecha de corte, el saldo en vivo de las pasarelas, el
// PDF, el modal de configuración y el libro de cada canal. De la nueva, el tipo
// de lugar, el holder, el agrupado por unidad de negocio, el resumen
// Disponible/Prestado/Total/Fondo, archivar/eliminar y las unidades.
//
// No inventa saldos: usa el `getValue` de la pantalla, así que la fecha elegida
// arriba manda sobre todo lo que se ve acá.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Archive,
  ArrowRightLeft,
  BookOpen,
  Building2,
  Calendar,
  Check,
  FileDown,
  HandCoins,
  Pencil,
  Plug,
  RefreshCw,
  Settings2,
  Trash2,
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
  isOnchain,
  normalizeLocationType,
  parseOnchainWallets,
  primaryUnitId,
  summarize,
  type BusinessUnit,
  type CashLocation,
  type LocationType,
  type OnchainWallet,
  type UnitShare,
} from '@/lib/cash-locations';
import type { OnchainSnapshotMeta } from '@/lib/types';
import { BusinessUnitsModal } from './business-units-modal';
import { UnitSharesEditor } from './unit-shares-editor';
import { OnchainWalletsEditor } from './onchain-wallets-editor';
import { OnchainBreakdown } from './onchain-breakdown';

interface Props {
  /** Canales visibles ya resueltos por la pantalla (built-ins + custom). */
  channels: ResolvedChannel[];
  /** Filas crudas de channel_configs — de acá salen tipo, unidad y holder. */
  configRows: ChannelConfigRow[];
  /** Saldo de cada canal a la fecha elegida, tal como lo calcula la pantalla. */
  getValue: (channelKey: string) => number;
  /** Recarga la config de canales en el padre tras guardar. */
  onChanged: () => void;
  canManage: boolean;
  /** Puede cargar el saldo a mano de los canales sin libro. */
  canEditBalance: boolean;
  selectedDate: string;
  onSelectedDate: (date: string) => void;
  reloading: boolean;
  onReload: () => void;
  onExportPdf: () => void;
  onConfigure: () => void;
  onSaveBalance: (channelKey: string, amount: number) => Promise<void>;
  /** Sub-filas propias de un canal (wallets fijadas de Coinsbuy). */
  extraRows?: (channelKey: string) => ReactNode;
  /** Acciones propias de un canal (elegir wallets de Coinsbuy). */
  extraActions?: (channelKey: string) => ReactNode;
  /**
   * Desglose que dejó el cron en el snapshot de la fecha elegida (migración
   * 085). De acá sale el "cuánto hay en cada moneda" de una wallet on-chain,
   * sin volver a consultar la blockchain al abrir la pantalla.
   */
  getSnapshotMeta?: (channelKey: string) => OnchainSnapshotMeta | null;
}

interface Draft {
  location_type: LocationType;
  holder: string;
  shares: UnitShare[];
  onchain: OnchainWallet[];
}

const INPUT =
  'h-11 sm:h-9 px-3 text-base sm:text-sm rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30';
const ICON_BTN =
  'min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 flex items-center justify-center rounded-lg';

export function ChannelBalancesCard({
  channels,
  configRows,
  getValue,
  onChanged,
  canManage,
  canEditBalance,
  selectedDate,
  onSelectedDate,
  reloading,
  onReload,
  onExportPdf,
  onConfigure,
  onSaveBalance,
  extraRows,
  extraActions,
  getSnapshotMeta,
}: Props) {
  const { t, locale } = useI18n();
  const lang = locale === 'en' ? 'en' : 'es';

  const [units, setUnits] = useState<BusinessUnit[]>([]);
  const [showUnits, setShowUnits] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [balanceDraft, setBalanceDraft] = useState<Record<string, string>>({});
  const [savingBalanceKey, setSavingBalanceKey] = useState<string | null>(null);

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

  // El reparto viene con `configRows`: desde que
  // `GET /api/admin/channel-configs` lo devuelve, el fetch aparte a
  // /api/admin/location-units era un segundo request pidiendo lo mismo y una
  // segunda copia del dato que se podía desincronizar de la primera. Tras
  // guardar, `onChanged()` recarga la configuración y con ella el reparto.
  const sharesByKey = useMemo(() => {
    const map = new Map<string, UnitShare[]>();
    for (const row of configRows) {
      const shares = (row.unit_shares ?? [])
        .filter((s) => s?.business_unit_id)
        .map((s) => ({ business_unit_id: s.business_unit_id, share: Number(s.share) || 0 }));
      if (shares.length > 0) map.set(row.channel_key, shares);
    }
    return map;
  }, [configRows]);

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
        unit_shares: sharesByKey.get(ch.key) ?? null,
        holder: row?.holder ?? null,
        is_visible: ch.isVisible,
        is_custom: ch.isCustom,
        sort_order: ch.sortOrder,
        onchain_wallets: parseOnchainWallets(row?.onchain_wallets),
        balance: getValue(ch.key),
      };
    });
  }, [channels, configRows, getValue, sharesByKey]);

  const summary = useMemo(() => summarize(locations, units), [locations, units]);
  const byUnit = useMemo(() => groupByUnit(locations, units), [locations, units]);
  const byType = useMemo(() => groupByType(locations), [locations]);

  // Una ubicación compartida aparece en cada unidad dueña, pero editarla,
  // archivarla o borrarla afecta a todas por igual: los botones van una sola
  // vez, en el primer grupo donde asoma.
  const primaryGroupOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of byUnit) {
      for (const loc of group.locations) {
        if (!map.has(loc.channel_key)) map.set(loc.channel_key, group.unit?.id ?? '');
      }
    }
    return map;
  }, [byUnit]);

  /**
   * Archivar = ocultar. Las pasarelas y los canales base NO se borran: su
   * libro y su histórico siguen existiendo y borrarlos dejaría asientos
   * huérfanos. Solo las ubicaciones propias (is_custom) se pueden eliminar,
   * y únicamente si su saldo es cero — si no, se estaría escondiendo plata.
   */
  const setArchived = async (loc: CashLocation, archived: boolean) => {
    setSaving(true);
    setStatus(null);
    try {
      const res = await apiFetch('/api/admin/channel-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsert',
          channel_key: loc.channel_key,
          is_visible: !archived,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? t('cash.saveError'));
      setStatus({ kind: 'ok', msg: archived ? t('cash.archived') : t('cash.unarchived') });
      onChanged();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : t('cash.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const removeLocation = async (loc: CashLocation) => {
    if (Math.abs(loc.balance) > 0.009) {
      setStatus({ kind: 'err', msg: t('cash.deleteNeedsZero') });
      return;
    }
    if (!window.confirm(t('cash.deleteLocationConfirm', { name: loc.label }))) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await apiFetch('/api/admin/channel-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // El endpoint espera `channel_key`: mandar `key` borraba nada y la
        // pantalla igual decía "eliminada".
        body: JSON.stringify({ action: 'delete', channel_key: loc.channel_key }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? t('cash.saveError'));
      setStatus({ kind: 'ok', msg: t('cash.deleted') });
      onChanged();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : t('cash.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (loc: CashLocation) => {
    setStatus(null);
    setEditingKey(loc.channel_key);
    setDraft({
      location_type: loc.location_type,
      holder: loc.holder ?? '',
      shares:
        loc.unit_shares && loc.unit_shares.length > 0
          ? loc.unit_shares.map((s) => ({ ...s }))
          : loc.business_unit_id
            ? [{ business_unit_id: loc.business_unit_id, share: 1 }]
            : [],
      onchain: parseOnchainWallets(loc.onchain_wallets).map((w) => ({ ...w })),
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
          // La unidad principal sigue viviendo en channel_configs para las
          // pantallas que la leen sin saber del reparto. Es la de MAYOR parte,
          // no la primera del array: con un reparto 30/70, guardar la primera
          // cargada dejaba la ubicación registrada bajo la unidad del 30%.
          business_unit_id: primaryUnitId(draft.shares),
          holder: draft.holder,
          // Se manda SIEMPRE (aunque venga vacío) porque este formulario es el
          // único lugar donde se desconecta una wallet de la cadena: omitirlo
          // dejaría las direcciones puestas para siempre. Las filas a medio
          // cargar se descartan acá; el servidor revalida y rechaza el resto.
          onchain_wallets: draft.onchain.filter((w) => w.address.trim()),
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? t('cash.saveError'));

      const sharesRes = await apiFetch('/api/admin/location-units', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_key: loc.channel_key, units: draft.shares }),
      });
      const sharesJson = (await sharesRes.json()) as { success: boolean; error?: string };
      if (!sharesJson.success) throw new Error(sharesJson.error ?? t('cash.saveError'));

      cancelEdit();
      setStatus({ kind: 'ok', msg: t('cash.saved') });
      // Recarga la configuración, que ahora trae también el reparto.
      onChanged();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : t('cash.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const saveBalance = async (channelKey: string) => {
    const value = parseFloat(balanceDraft[channelKey] ?? '');
    if (!Number.isFinite(value)) {
      setStatus({ kind: 'err', msg: t('balances.invalidNumber') });
      return;
    }
    setSavingBalanceKey(channelKey);
    setStatus(null);
    try {
      await onSaveBalance(channelKey, value);
      setBalanceDraft((prev) => {
        const { [channelKey]: _omit, ...rest } = prev;
        return rest;
      });
    } catch (err) {
      setStatus({
        kind: 'err',
        msg: err instanceof Error ? err.message : t('balances.saveErrorGeneric'),
      });
    } finally {
      setSavingBalanceKey(null);
    }
  };

  const typeLabel = (type: LocationType) => LOCATION_TYPE_LABELS[type][lang];

  return (
    <Card>
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-accent/10">
            <Plug className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">{t('balances.byChannel')}</h2>
            <p className="text-xs text-muted-foreground">{t('cash.subtitle')}</p>
          </div>
        </div>

        {/* Fecha de corte: manda sobre todos los saldos de la tarjeta. El cron
            escribe un snapshot diario a las 00:00 UTC, así que cualquier día
            pasado se puede consultar. */}
        <div className="flex flex-wrap items-center gap-2">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => onSelectedDate(e.target.value)}
            className={INPUT}
            aria-label={t('balances.snapshotDate')}
          />
          <button
            onClick={onReload}
            disabled={reloading}
            className={`${ICON_BTN} border border-border bg-card hover:bg-muted transition-colors disabled:opacity-50`}
            title={t('balances.reload')}
            aria-label={t('balances.reload')}
          >
            <RefreshCw className={`w-4 h-4 ${reloading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onExportPdf}
            disabled={channels.length === 0}
            className="inline-flex items-center gap-1.5 min-h-11 sm:min-h-9 px-3 text-sm rounded-lg border border-border bg-card hover:bg-muted transition-colors disabled:opacity-50"
            title={t('ledger.exportPdf')}
          >
            <FileDown className="w-4 h-4" />
            <span className="hidden sm:inline">PDF</span>
          </button>
          {canManage && (
            <>
              <button
                onClick={onConfigure}
                className="inline-flex items-center gap-1.5 min-h-11 sm:min-h-9 px-3 text-sm rounded-lg border border-border bg-card hover:bg-muted transition-colors"
                title={t('balances.configureChannels')}
              >
                <Settings2 className="w-4 h-4" />
                <span className="hidden sm:inline">{t('balances.configure')}</span>
              </button>
              <button
                onClick={() => setShowUnits(true)}
                className="inline-flex items-center gap-1.5 min-h-11 sm:min-h-9 px-3 text-sm rounded-lg border border-border bg-card hover:bg-muted transition-colors"
              >
                <Building2 className="w-4 h-4" />
                {t('cash.manageUnits')}
              </button>
            </>
          )}
        </div>
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
          <p className="text-xs text-muted-foreground uppercase tracking-wide">{t('balances.totalConsolidated')}</p>
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

      {channels.length === 0 && (
        <p className="text-sm text-muted-foreground py-6 text-center">
          {t('balances.noVisibleChannelsPre')} <strong>{t('balances.configure')}</strong>{' '}
          {t('balances.noVisibleChannelsPost')}
        </p>
      )}

      {/* Ubicaciones agrupadas por unidad de negocio */}
      <div className="mt-6 space-y-4">
        {channels.length > 0 && (
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t('cash.byUnit')}
          </h3>
        )}

        {byUnit.map((group) => (
          <div key={group.unit?.id ?? 'unassigned'} className="rounded-lg border border-border overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-muted/40">
              <div className="flex items-center gap-2 min-w-0">
                <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                <p className="font-medium truncate">{group.unit ? group.unit.name : t('cash.noUnit')}</p>
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
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-semibold tabular-nums">{formatCurrency(group.total)}</span>
                {/* El libro consolidado existía pero solo se llegaba haciendo
                    click en el nombre de la unidad: nadie lo encontraba. */}
                {group.unit && (
                  <Link
                    href={`/balances/unidad/${encodeURIComponent(group.unit.id)}`}
                    className="inline-flex items-center gap-1.5 min-h-11 sm:min-h-9 px-3 text-xs rounded-lg border border-border bg-card hover:bg-muted transition-colors"
                    title={t('unitLedger.openBook')}
                  >
                    <ArrowRightLeft className="w-3.5 h-3.5" />
                    {t('cash.viewMovements')}
                  </Link>
                )}
              </div>
            </div>

            <div className="divide-y divide-border">
              {group.locations.map((loc) => {
                const editing = editingKey === loc.channel_key;
                // Una wallet on-chain es tan automática como una pasarela: su
                // saldo lo pone el cron desde la cadena, así que tampoco se
                // edita a mano. `isAutomatic` mira el TIPO y `isOnchain` la
                // FILA — son dos preguntas distintas sobre la misma ubicación.
                const onchain = isOnchain(loc);
                const automatic = isAutomatic(loc.location_type) || onchain;
                const onchainMeta = onchain ? getSnapshotMeta?.(loc.channel_key) ?? null : null;
                const editingBalance = balanceDraft[loc.channel_key] !== undefined;
                // El saldo de un canal con libro no se sobreescribe a mano: se
                // carga un asiento. Dos vías serían dos fuentes de verdad para
                // el mismo número.
                const isPrimary = primaryGroupOf.get(loc.channel_key) === (group.unit?.id ?? '');
                const canTypeBalance =
                  isPrimary && canEditBalance && !hasLedger(loc.channel_key) && !automatic;
                const partial = loc.share < 0.9999;
                return (
                  <div key={`${group.unit?.id ?? 'none'}-${loc.channel_key}`} className="p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Wallet className="w-4 h-4 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <p className="font-medium truncate">{loc.label}</p>
                            {onchain && (
                              <span
                                className="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-accent/10 text-accent border border-accent/30"
                                title={parseOnchainWallets(loc.onchain_wallets)
                                  .map((w) => `${w.network}: ${w.address}`)
                                  .join('\n')}
                              >
                                {t('onchain.badge')}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">
                            {typeLabel(loc.location_type)}
                            {loc.holder ? ` · ${loc.holder}` : ''}
                            {automatic ? ` · ${t('cash.autoSynced')}` : ''}
                            {partial
                              ? ` · ${t('cash.sharedLocation', {
                                  percent: (loc.share * 100).toFixed(loc.share * 100 % 1 === 0 ? 0 : 2),
                                  total: formatCurrency(loc.fullBalance),
                                })}`
                              : ''}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {editingBalance ? (
                          <>
                            <input
                              type="number"
                              step="0.01"
                              value={balanceDraft[loc.channel_key]}
                              onChange={(e) =>
                                setBalanceDraft((prev) => ({ ...prev, [loc.channel_key]: e.target.value }))
                              }
                              className={`${INPUT} w-32 text-right`}
                              aria-label={t('balances.editBalance')}
                              autoFocus
                            />
                            <button
                              onClick={() => saveBalance(loc.channel_key)}
                              disabled={savingBalanceKey === loc.channel_key}
                              className={`${ICON_BTN} text-positive hover:bg-positive/10 disabled:opacity-40`}
                              aria-label={t('common.save')}
                            >
                              {savingBalanceKey === loc.channel_key ? (
                                <RefreshCw className="w-4 h-4 animate-spin" />
                              ) : (
                                <Check className="w-4 h-4" />
                              )}
                            </button>
                            <button
                              onClick={() =>
                                setBalanceDraft((prev) => {
                                  const { [loc.channel_key]: _omit, ...rest } = prev;
                                  return rest;
                                })
                              }
                              className={`${ICON_BTN} text-muted-foreground hover:bg-muted`}
                              aria-label={t('common.cancel')}
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </>
                        ) : (
                          <>
                            <span
                              className={`font-semibold tabular-nums ${
                                isLiquid(loc.location_type) ? '' : 'text-warning'
                              }`}
                            >
                              {formatCurrency(loc.balance)}
                            </span>
                            {hasLedger(loc.channel_key) ? (
                              <Link
                                href={`/balances/libro/${encodeURIComponent(loc.channel_key)}`}
                                className={`${ICON_BTN} text-accent hover:bg-accent/10`}
                                title={t('ledger.openBook')}
                                aria-label={`${t('ledger.openBook')} — ${loc.label}`}
                              >
                                <BookOpen className="w-4 h-4" />
                              </Link>
                            ) : (
                              canTypeBalance && (
                                <button
                                  onClick={() =>
                                    setBalanceDraft((prev) => ({
                                      ...prev,
                                      [loc.channel_key]: String(loc.fullBalance),
                                    }))
                                  }
                                  className={`${ICON_BTN} text-accent hover:bg-accent/10`}
                                  title={t('balances.editBalance')}
                                  aria-label={`${t('balances.editBalance')} — ${loc.label}`}
                                >
                                  <Pencil className="w-4 h-4" />
                                </button>
                              )
                            )}
                            {isPrimary && extraActions?.(loc.channel_key)}
                            {isPrimary && canManage && !editing && (
                              <button
                                onClick={() => startEdit(loc)}
                                className={`${ICON_BTN} text-accent hover:bg-accent/10`}
                                title={t('cash.editLocation')}
                                aria-label={`${t('cash.editLocation')} — ${loc.label}`}
                              >
                                <Settings2 className="w-4 h-4" />
                              </button>
                            )}
                            {isPrimary && canManage && (
                              <button
                                type="button"
                                onClick={() => setArchived(loc, loc.is_visible)}
                                disabled={saving}
                                className={`${ICON_BTN} text-muted-foreground hover:bg-muted disabled:opacity-40`}
                                title={loc.is_visible ? t('cash.archive') : t('cash.unarchive')}
                                aria-label={`${loc.is_visible ? t('cash.archive') : t('cash.unarchive')} — ${loc.label}`}
                              >
                                <Archive className="w-4 h-4" />
                              </button>
                            )}
                            {isPrimary && canManage && loc.is_custom && (
                              <button
                                type="button"
                                onClick={() => removeLocation(loc)}
                                disabled={saving}
                                className={`${ICON_BTN} text-negative hover:bg-negative/10 disabled:opacity-40`}
                                title={t('cash.deleteLocation')}
                                aria-label={`${t('cash.deleteLocation')} — ${loc.label}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {/* Cuánto hay en cada moneda — del snapshot, no de la cadena. */}
                    {onchainMeta && <OnchainBreakdown meta={onchainMeta} share={loc.share} />}

                    {isPrimary && extraRows?.(loc.channel_key)}

                    {editing && draft && (
                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                          {t('cash.locationType')}
                          <select
                            value={draft.location_type}
                            onChange={(e) =>
                              setDraft({ ...draft, location_type: e.target.value as LocationType })
                            }
                            className={INPUT}
                          >
                            {LOCATION_TYPES.map((type) => (
                              <option key={type} value={type}>
                                {typeLabel(type)}
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
                            className={INPUT}
                          />
                        </label>
                        <div className="sm:col-span-2">
                          <UnitSharesEditor
                            units={units}
                            value={draft.shares}
                            onChange={(shares) => setDraft({ ...draft, shares })}
                          />
                        </div>
                        {/* Solo para wallets: una cuenta bancaria o un préstamo
                            no tienen dirección en una blockchain. */}
                        {draft.location_type === 'wallet' && (
                          <div className="sm:col-span-2 pt-2 border-t border-border">
                            <OnchainWalletsEditor
                              value={draft.onchain}
                              onChange={(onchain) => setDraft({ ...draft, onchain })}
                              disabled={saving}
                            />
                          </div>
                        )}
                        <div className="sm:col-span-2 flex items-center justify-between gap-2">
                          <p className="text-[11px] text-muted-foreground">
                            {automatic ? t('cash.autoBalanceNote') : t('cash.manualBalanceNote')}
                          </p>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => saveEdit(loc)}
                              disabled={saving}
                              className={`${ICON_BTN} text-positive hover:bg-positive/10 disabled:opacity-40`}
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
                              className={`${ICON_BTN} text-muted-foreground hover:bg-muted`}
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
            // Borrar una unidad borra en cascada sus filas de reparto, así que
            // la configuración también hay que releerla.
            onChanged();
          }}
        />
      )}
    </Card>
  );
}
