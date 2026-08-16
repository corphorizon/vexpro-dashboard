'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChannelConfigModal
//
// Panel "Configurar" de Balances por Canal, solo para admins:
//   · Muestra u oculta cualquier canal (predefinido o propio).
//   · Renombra los manuales (los de API conservan el nombre del proveedor).
//   · DA DE ALTA un lugar donde está el dinero: nombre, saldo inicial, tipo
//     (wallet / banco / efectivo / trading / pasarela / prestado), holder y las
//     unidades de negocio dueñas con su porcentaje. Antes solo se podía crear
//     un "canal" pelado y el tipo había que ponérselo después en otra pantalla,
//     así que no había forma de cargar un "Préstamo a Kevin".
//   · Elimina los propios (los predefinidos solo se ocultan).
//
// Todo se persiste en /api/admin/channel-configs y el reparto por unidad en
// /api/admin/location-units. Tras cada mutación se llama `onChanged()` para que
// la pantalla vuelva a leer la configuración.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Lock,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { ResolvedChannel, ChannelConfigRow } from '@/lib/channel-configs';
import { apiFetch } from '@/lib/api-fetch';
import { resolveChannels } from '@/lib/channel-configs';
import { formatCurrency } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import {
  DEFAULT_LOCATION_TYPE,
  LOCATION_TYPES,
  LOCATION_TYPE_LABELS,
  primaryUnitId,
  validateOnchainWallets,
  type BusinessUnit,
  type LocationType,
  type OnchainWallet,
  type UnitShare,
} from '@/lib/cash-locations';
import { UnitSharesEditor } from './unit-shares-editor';
import { OnchainWalletsEditor } from './onchain-wallets-editor';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after any successful mutation — parent refetches config. */
  onChanged: () => void;
  /** Resolved value for each channel at the currently-viewed date — used
   *  as read-only preview inside the modal. */
  getValue: (channelKey: string) => number;
}

const INPUT =
  'h-11 sm:h-9 px-3 text-base sm:text-sm rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30';

export function ChannelConfigModal({ open, onClose, onChanged, getValue }: Props) {
  const { t, locale } = useI18n();
  const lang = locale === 'en' ? 'en' : 'es';

  const [rows, setRows] = useState<ChannelConfigRow[]>([]);
  const [units, setUnits] = useState<BusinessUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [editingLabelFor, setEditingLabelFor] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelBalance, setNewChannelBalance] = useState('');
  const [newType, setNewType] = useState<LocationType>(DEFAULT_LOCATION_TYPE);
  const [newHolder, setNewHolder] = useState('');
  const [newShares, setNewShares] = useState<UnitShare[]>([]);
  const [newOnchain, setNewOnchain] = useState<OnchainWallet[]>([]);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  const loadUnits = useCallback(async () => {
    try {
      const res = await apiFetch('/api/admin/business-units');
      const json = (await res.json()) as { success: boolean; units?: BusinessUnit[] };
      if (json.success) setUnits(json.units ?? []);
    } catch {
      // Sin unidades el alta sigue funcionando: la ubicación queda sin dueña.
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setEditingLabelFor(null);
    setNewChannelName('');
    setNewChannelBalance('');
    setNewType(DEFAULT_LOCATION_TYPE);
    setNewHolder('');
    setNewShares([]);
    setNewOnchain([]);
    setLoading(true);
    loadUnits();
    (async () => {
      try {
        const res = await apiFetch('/api/admin/channel-configs');
        const json = (await res.json()) as { success: boolean; rows?: ChannelConfigRow[] };
        if (json.success) setRows(json.rows ?? []);
        else throw new Error(t('balances.cfgLoadError'));
      } catch (err) {
        setStatus({
          kind: 'err',
          msg: err instanceof Error ? err.message : t('balances.cfgLoadError'),
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [open, loadUnits, t]);

  const resolved: ResolvedChannel[] = resolveChannels(rows);

  async function refresh() {
    const res = await apiFetch('/api/admin/channel-configs');
    const json = (await res.json()) as { success: boolean; rows?: ChannelConfigRow[] };
    if (json.success) setRows(json.rows ?? []);
    onChanged();
  }

  async function upsert(
    channel_key: string,
    patch: Partial<Pick<ChannelConfigRow, 'custom_label' | 'is_visible' | 'sort_order'>>,
  ) {
    setSaving(channel_key);
    setStatus(null);
    try {
      const res = await apiFetch('/api/admin/channel-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upsert', channel_key, ...patch }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? t('balances.cfgSaveError'));
      await refresh();
    } catch (err) {
      setStatus({
        kind: 'err',
        msg: err instanceof Error ? err.message : t('balances.cfgSaveError'),
      });
    } finally {
      setSaving(null);
    }
  }

  async function toggleVisible(ch: ResolvedChannel) {
    await upsert(ch.key, { is_visible: !ch.isVisible });
  }

  async function saveLabel(ch: ResolvedChannel) {
    const clean = labelDraft.trim();
    if (!clean) {
      setStatus({ kind: 'err', msg: t('balances.cfgNameEmpty') });
      return;
    }
    await upsert(ch.key, { custom_label: clean });
    setEditingLabelFor(null);
    setLabelDraft('');
  }

  async function createCustom() {
    const clean = newChannelName.trim();
    if (!clean) {
      setStatus({ kind: 'err', msg: t('balances.cfgNameRequired') });
      return;
    }
    // Las direcciones se validan ANTES de crear nada: si una está mal, el alta
    // fallaría del lado del servidor dejando el nombre y el saldo cargados a
    // medias. Se usa la misma función que corre allá, así el mensaje es uno solo.
    const onchain = validateOnchainWallets(newOnchain.filter((w) => w.address.trim()));
    if (onchain.error) {
      setStatus({ kind: 'err', msg: onchain.error });
      return;
    }

    setCreating(true);
    setStatus(null);
    try {
      const initial = parseFloat(newChannelBalance);
      const res = await apiFetch('/api/admin/channel-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_custom',
          label: clean,
          initial_balance: isNaN(initial) ? undefined : initial,
          location_type: newType,
          holder: newHolder,
          // La unidad de MAYOR parte queda como principal en channel_configs,
          // que es lo que leen las pantallas que no saben del reparto. Tomar
          // la primera del array registraba una wallet 30/70 bajo la unidad
          // del 30% solo porque era la fila cargada primero — para eso existe
          // primaryUnitId (auditoría 2026-08, A5).
          business_unit_id: primaryUnitId(newShares),
          // Solo tiene sentido en una wallet: un banco o un préstamo no tienen
          // dirección en una blockchain, y el bloque ni siquiera se muestra.
          onchain_wallets: newType === 'wallet' ? onchain.wallets : [],
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string; channel_key?: string };
      if (!json.success) throw new Error(json.error ?? t('balances.cfgCreateError'));

      if (json.channel_key && newShares.length > 0) {
        const sharesRes = await apiFetch('/api/admin/location-units', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel_key: json.channel_key, units: newShares }),
        });
        const sharesJson = (await sharesRes.json()) as { success: boolean; error?: string };
        if (!sharesJson.success) throw new Error(sharesJson.error ?? t('balances.cfgCreateError'));
      }

      setNewChannelName('');
      setNewChannelBalance('');
      setNewType(DEFAULT_LOCATION_TYPE);
      setNewHolder('');
      setNewShares([]);
      setNewOnchain([]);
      setStatus({ kind: 'ok', msg: t('balances.cfgCreated') });
      await refresh();
    } catch (err) {
      setStatus({
        kind: 'err',
        msg: err instanceof Error ? err.message : t('balances.cfgCreateError'),
      });
    } finally {
      setCreating(false);
    }
  }

  async function deleteCustom(ch: ResolvedChannel) {
    if (!ch.isCustom) return;
    if (!confirm(t('balances.cfgDeleteConfirm', { name: ch.label }))) return;
    setSaving(ch.key);
    setStatus(null);
    try {
      const res = await apiFetch('/api/admin/channel-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', channel_key: ch.key }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? t('balances.cfgDeleteError'));
      await refresh();
    } catch (err) {
      setStatus({
        kind: 'err',
        msg: err instanceof Error ? err.message : t('balances.cfgDeleteError'),
      });
    } finally {
      setSaving(null);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-border sticky top-0 bg-background">
          <div>
            <h2 className="text-lg font-semibold">{t('balances.cfgTitle')}</h2>
            <p className="text-xs text-muted-foreground">{t('balances.cfgHint')}</p>
          </div>
          <button
            onClick={onClose}
            className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 flex items-center justify-center rounded-md hover:bg-muted"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {status && (
            <div
              className={`flex items-start gap-2 p-3 rounded-md text-xs border ${
                status.kind === 'ok'
                  ? 'bg-positive/10 border-positive/30 text-positive'
                  : 'bg-negative/10 border-negative/30 text-negative'
              }`}
            >
              {status.kind === 'err' && <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
              <span>{status.msg}</span>
            </div>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : (
            <>
              <section className="space-y-2">
                <h3 className="text-sm font-medium">{t('balances.cfgChannels')}</h3>
                {resolved.map((ch) => {
                  const isApi = ch.type === 'auto' && (ch.key === 'coinsbuy' || ch.key === 'unipayment');
                  const canRename = !isApi; // manual + custom + derived auto (liquidez/inversiones)
                  const editing = editingLabelFor === ch.key;
                  const busy = saving === ch.key;
                  return (
                    <div
                      key={ch.key}
                      className={`flex items-center gap-3 p-3 rounded-lg border ${
                        ch.isVisible ? 'border-border' : 'border-border border-dashed bg-muted/20'
                      }`}
                    >
                      {/* Visibility toggle */}
                      <button
                        onClick={() => toggleVisible(ch)}
                        disabled={busy}
                        className={`shrink-0 p-1.5 rounded-md border ${
                          ch.isVisible
                            ? 'border-positive/40 text-positive bg-positive/10'
                            : 'border-muted text-muted-foreground'
                        } disabled:opacity-50`}
                        aria-label={ch.isVisible ? t('balances.cfgHide') : t('balances.cfgShow')}
                        title={ch.isVisible ? t('balances.cfgVisibleTitle') : t('balances.cfgHiddenTitle')}
                      >
                        {ch.isVisible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                      </button>

                      <div className="flex-1 min-w-0">
                        {editing ? (
                          <div className="flex items-center gap-2">
                            <input
                              value={labelDraft}
                              onChange={(e) => setLabelDraft(e.target.value)}
                              className={`${INPUT} flex-1 min-w-0`}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void saveLabel(ch);
                                }
                                if (e.key === 'Escape') {
                                  setEditingLabelFor(null);
                                  setLabelDraft('');
                                }
                              }}
                              autoFocus
                            />
                            <button
                              onClick={() => saveLabel(ch)}
                              disabled={busy}
                              className="p-1 text-positive hover:bg-positive/10 rounded"
                              aria-label={t('balances.cfgSaveName')}
                            >
                              <Save className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => {
                                setEditingLabelFor(null);
                                setLabelDraft('');
                              }}
                              className="p-1 text-muted-foreground hover:bg-muted rounded"
                              aria-label={t('common.cancel')}
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium truncate">{ch.label}</p>
                              {isApi && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-info/10 text-blue-700 dark:text-blue-300 border border-info/30">
                                  <Lock className="w-2.5 h-2.5" /> API
                                </span>
                              )}
                              {ch.isBuiltin && !isApi && (
                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground border border-border">
                                  {t('balances.cfgBuiltin')}
                                </span>
                              )}
                              {ch.isCustom && (
                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-accent/10 text-accent border border-accent/30">
                                  {t('balances.cfgCustom')}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">
                              {ch.description} · {t('balances.cfgCurrentBalance')}{' '}
                              <span className="font-medium">{formatCurrency(getValue(ch.key))}</span>
                            </p>
                          </>
                        )}
                      </div>

                      {!editing && (
                        <div className="flex items-center gap-1 shrink-0">
                          {canRename && (
                            <button
                              onClick={() => {
                                setEditingLabelFor(ch.key);
                                setLabelDraft(ch.label);
                              }}
                              disabled={busy}
                              className="p-1.5 text-accent hover:bg-accent/10 rounded disabled:opacity-50"
                              title={t('balances.cfgRename')}
                              aria-label={t('balances.cfgRename')}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {ch.isCustom && (
                            <button
                              onClick={() => deleteCustom(ch)}
                              disabled={busy}
                              className="p-1.5 text-negative hover:bg-negative/10 rounded disabled:opacity-50"
                              title={t('balances.cfgDeleteChannel')}
                              aria-label={t('balances.cfgDeleteChannel')}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>

              {/* Alta de una ubicación nueva, con todo lo que la define */}
              <section className="pt-3 border-t border-border space-y-3">
                <h3 className="text-sm font-medium">{t('balances.cfgAddLocation')}</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    value={newChannelName}
                    onChange={(e) => setNewChannelName(e.target.value)}
                    placeholder={t('balances.cfgNamePlaceholder')}
                    className={INPUT}
                    aria-label={t('balances.cfgNamePlaceholder')}
                  />
                  <input
                    type="number"
                    step="0.01"
                    value={newChannelBalance}
                    onChange={(e) => setNewChannelBalance(e.target.value)}
                    placeholder={t('balances.cfgInitialBalance')}
                    className={`${INPUT} text-right`}
                    aria-label={t('balances.cfgInitialBalance')}
                  />
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {t('cash.locationType')}
                    <select
                      value={newType}
                      onChange={(e) => setNewType(e.target.value as LocationType)}
                      className={INPUT}
                    >
                      {LOCATION_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {LOCATION_TYPE_LABELS[type][lang]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {t('cash.holder')}
                    <input
                      value={newHolder}
                      onChange={(e) => setNewHolder(e.target.value)}
                      placeholder={t('cash.holderPlaceholder')}
                      className={INPUT}
                    />
                  </label>
                </div>

                <UnitSharesEditor units={units} value={newShares} onChange={setNewShares} />

                {/* Balance automático desde la blockchain — solo para wallets.
                    Con una dirección cargada, la ubicación deja de cargarse a
                    mano: el saldo lo pone el cron leyendo la cadena. */}
                {newType === 'wallet' && (
                  <div className="pt-3 border-t border-border">
                    <OnchainWalletsEditor
                      value={newOnchain}
                      onChange={setNewOnchain}
                      disabled={creating}
                    />
                  </div>
                )}

                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">{t('balances.cfgAddHint')}</p>
                  <button
                    onClick={createCustom}
                    disabled={creating || !newChannelName.trim()}
                    className="inline-flex items-center justify-center gap-1.5 min-h-11 sm:min-h-9 px-4 rounded-md bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                    {creating ? t('balances.cfgAdding') : t('balances.cfgAdd')}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>

        <div className="p-5 border-t border-border sticky bottom-0 bg-background flex justify-end">
          <button
            onClick={onClose}
            className="min-h-11 sm:min-h-9 px-4 rounded-lg border border-border text-sm hover:bg-muted"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
