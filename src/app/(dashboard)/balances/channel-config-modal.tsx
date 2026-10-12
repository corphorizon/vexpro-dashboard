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
//   · Tipo «Préstamo recibido de» (`debt`, 2026-10-05): un préstamo que una
//     persona le hizo a la EMPRESA. El holder (quién prestó) es obligatorio y
//     el «Balance inicial» pasa a ser el monto del préstamo, siempre positivo:
//     el signo lo pone `signedBalance` en cash-locations.ts, nunca el usuario.
//     Por qué resta y no suma: ver la cabecera de cash-locations.ts.
//
// Todo se persiste en /api/admin/channel-configs y el reparto por unidad en
// /api/admin/location-units. Tras cada mutación se llama `onChanged()` para que
// la pantalla vuelva a leer la configuración.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import {
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { ResolvedChannel, ChannelConfigRow } from '@/lib/channel-configs';
import { apiFetch } from '@/lib/api-fetch';
import { resolveChannels } from '@/lib/channel-configs';
import { canRenameChannel } from '@/lib/api-channels';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { Field, Input, Select } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { NUM_CLASS } from '@/components/ui/money';
import { useI18n } from '@/lib/i18n';
import {
  DEFAULT_LOCATION_TYPE,
  LOCATION_TYPES,
  LOCATION_TYPE_LABELS,
  isDebt,
  normalizeLocationType,
  primaryUnitId,
  requiresHolder,
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

// «Libro mayor» (2026-10-12): controles con `Field/Input/Select` (borde
// `control-border` 3:1 y label siempre visible — antes el nombre y el saldo
// inicial tenían sólo placeholder, que desaparece al escribir), avisos con
// `Notice`, estados con `StatusBadge` (el «API» era azul 700 de la
// paleta cruda con variante oscura a mano) y «Oculto · no suma» en texto, no sólo el
// ojo tachado. Sólo presentación: alta, deuda, on-chain y reparto no cambiaron.
const BTN =
  'inline-flex h-8 items-center gap-1.5 rounded-ui-md border border-border-strong bg-card px-3 text-[13px] font-medium text-foreground hover:bg-surface-2 disabled:opacity-50 [@media(pointer:coarse)]:h-10';
const ICON_BTN =
  'inline-flex size-8 items-center justify-center rounded-ui-md border border-border-strong bg-card text-text-2 hover:bg-surface-2 disabled:opacity-50 [@media(pointer:coarse)]:size-10';
const ROW_BTN =
  'inline-flex size-8 items-center justify-center rounded-ui-md text-text-2 hover:bg-surface-2 hover:text-foreground disabled:opacity-50 [@media(pointer:coarse)]:size-10';

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
  const rowByKey = new Map(rows.map((r) => [r.channel_key, r]));
  const newIsDebt = isDebt(newType);

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
    // Una deuda sin acreedor no se puede pagar ni conciliar; y un monto
    // negativo, con el signo que ya pone el sistema, terminaría SUMANDO al
    // total. El servidor valida lo mismo.
    if (requiresHolder(newType) && !newHolder.trim()) {
      setStatus({ kind: 'err', msg: t('balances.cfgDebtNeedsHolder') });
      return;
    }
    if (isDebt(newType) && parseFloat(newChannelBalance) < 0) {
      setStatus({ kind: 'err', msg: t('balances.cfgDebtNegative') });
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
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-config-title"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-ui-xl border border-border bg-card shadow-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-[1] flex items-center justify-between gap-3 border-b border-border bg-card px-5 py-4">
          <div className="min-w-0">
            <h2 id="channel-config-title" className="text-[15px] font-semibold text-foreground">
              {t('balances.cfgTitle')}
            </h2>
            <p className="text-[12.5px] text-text-3">{t('balances.cfgHint')}</p>
          </div>
          <button type="button" onClick={onClose} className={ICON_BTN} aria-label={t('common.close')}>
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <div className="space-y-5 p-5">
          {status &&
            (status.kind === 'err' ? (
              <Notice kind="bad" title={status.msg} />
            ) : (
              <p role="status" className="text-[13px] font-medium text-pos">
                {status.msg}
              </p>
            ))}

          {loading ? (
            <p className="text-[13px] text-text-3">{t('common.loading')}</p>
          ) : (
            <>
              <section className="space-y-2">
                <h3 className="text-[13.5px] font-semibold text-foreground">{t('balances.cfgChannels')}</h3>
                <ul className="divide-y divide-border rounded-ui-md border border-border">
                  {resolved.map((ch) => {
                    // Quién se puede renombrar sale del registro único
                    // (src/lib/api-channels.ts). Acá había una copia literal de
                    // la del servidor con DOS canales, cuando ya había cuatro
                    // automáticos: FairPay y Pay-Pros se ofrecían renombrables y
                    // el servidor —que tenía la MISMA lista vieja— los aceptaba
                    // (2026-08-31, auditoría de finanzas, ítem 14).
                    // Sigue incluyendo manual + custom + los `auto` DERIVADOS
                    // (liquidez / inversiones), cuyo nombre es nuestro.
                    const canRename = canRenameChannel(ch.key, ch.isCustom);
                    const isApi = !canRename;
                    const editing = editingLabelFor === ch.key;
                    const busy = saving === ch.key;
                    const row = rowByKey.get(ch.key);
                    const debtRow =
                      row && isDebt(normalizeLocationType(row.location_type)) ? row : null;
                    return (
                      <li
                        key={ch.key}
                        className={cn('flex items-center gap-3 px-3 py-2.5', !ch.isVisible && 'bg-surface-2')}
                      >
                        {/* Visibility toggle */}
                        <button
                          type="button"
                          onClick={() => toggleVisible(ch)}
                          disabled={busy}
                          aria-pressed={ch.isVisible}
                          className={cn(ICON_BTN, 'shrink-0', !ch.isVisible && 'border-dashed text-text-3')}
                          aria-label={ch.isVisible ? t('balances.cfgHide') : t('balances.cfgShow')}
                          title={ch.isVisible ? t('balances.cfgVisibleTitle') : t('balances.cfgHiddenTitle')}
                        >
                          {ch.isVisible ? (
                            <Eye aria-hidden className="size-4" strokeWidth={1.75} />
                          ) : (
                            <EyeOff aria-hidden className="size-4" strokeWidth={1.75} />
                          )}
                        </button>

                        <div className="min-w-0 flex-1">
                          {editing ? (
                            <div className="flex items-center gap-2">
                              <Input
                                value={labelDraft}
                                onChange={(e) => setLabelDraft(e.target.value)}
                                aria-label={t('balances.cfgRename')}
                                className="min-w-0 flex-1"
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
                                type="button"
                                onClick={() => saveLabel(ch)}
                                disabled={busy}
                                className={ROW_BTN}
                                aria-label={t('balances.cfgSaveName')}
                              >
                                <Save aria-hidden className="size-4" strokeWidth={1.75} />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingLabelFor(null);
                                  setLabelDraft('');
                                }}
                                className={ROW_BTN}
                                aria-label={t('common.cancel')}
                              >
                                <X aria-hidden className="size-4" />
                              </button>
                            </div>
                          ) : (
                            <>
                              <div className="flex flex-wrap items-center gap-1.5">
                                <p className="truncate text-[13px] font-medium text-foreground">{ch.label}</p>
                                {isApi && <StatusBadge kind="info" label="API" />}
                                {ch.isBuiltin && !isApi && (
                                  <StatusBadge kind="neutral" label={t('balances.cfgBuiltin')} />
                                )}
                                {ch.isCustom && <StatusBadge kind="neutral" label={t('balances.cfgCustom')} />}
                                {/* Oculto = fuera del total: se dice con texto,
                                    no sólo con el ícono tachado. */}
                                {!ch.isVisible && <StatusBadge kind="neutral" label={t('balances.cfgHiddenBadge')} />}
                              </div>
                              {debtRow ? (
                                // Una deuda: rótulo + acreedor + monto con color
                                // de pasivo. Sin esto se leía como «Balance actual:
                                // $10.000», igual que una wallet con plata.
                                <p className="truncate text-[12px] text-text-3">
                                  <span className="font-medium text-neg">
                                    {t('cash.debtPrefix')} · {formatMoney(getValue(ch.key))}
                                  </span>
                                  {debtRow.holder ? ` · ${debtRow.holder}` : ''}
                                </p>
                              ) : (
                                <p className="truncate text-[12px] text-text-3">
                                  {ch.description} · {t('balances.cfgCurrentBalance')}{' '}
                                  <span className={cn(NUM_CLASS, 'font-medium text-text-2')}>
                                    {formatMoney(getValue(ch.key))}
                                  </span>
                                </p>
                              )}
                            </>
                          )}
                        </div>

                        {!editing && (
                          <div className="flex shrink-0 items-center gap-1">
                            {canRename && (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingLabelFor(ch.key);
                                  setLabelDraft(ch.label);
                                }}
                                disabled={busy}
                                className={ROW_BTN}
                                title={t('balances.cfgRename')}
                                aria-label={`${t('balances.cfgRename')} — ${ch.label}`}
                              >
                                <Pencil aria-hidden className="size-4" strokeWidth={1.75} />
                              </button>
                            )}
                            {ch.isCustom && (
                              <button
                                type="button"
                                onClick={() => deleteCustom(ch)}
                                disabled={busy}
                                className={cn(ROW_BTN, 'hover:text-neg')}
                                title={t('balances.cfgDeleteChannel')}
                                aria-label={`${t('balances.cfgDeleteChannel')} — ${ch.label}`}
                              >
                                <Trash2 aria-hidden className="size-4" strokeWidth={1.75} />
                              </button>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              {/* Alta de una ubicación nueva, con todo lo que la define */}
              <section className="space-y-3 border-t border-border pt-4">
                <h3 className="text-[13.5px] font-semibold text-foreground">{t('balances.cfgAddLocation')}</h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label={t('balances.cfgNamePlaceholder')} required>
                    <Input value={newChannelName} onChange={(e) => setNewChannelName(e.target.value)} />
                  </Field>
                  <Field label={newIsDebt ? t('balances.cfgLoanAmount') : t('balances.cfgInitialBalance')}>
                    <Input
                      type="number"
                      step="0.01"
                      min={newIsDebt ? 0 : undefined}
                      inputMode="decimal"
                      value={newChannelBalance}
                      onChange={(e) => setNewChannelBalance(e.target.value)}
                      className="text-right tabular-nums"
                    />
                  </Field>
                  <Field label={t('cash.locationType')}>
                    <Select value={newType} onChange={(e) => setNewType(e.target.value as LocationType)}>
                      {LOCATION_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {LOCATION_TYPE_LABELS[type][lang]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('cash.holder')} required={requiresHolder(newType)}>
                    <Input
                      value={newHolder}
                      onChange={(e) => setNewHolder(e.target.value)}
                      placeholder={newIsDebt ? t('cash.debtHolderPlaceholder') : t('cash.holderPlaceholder')}
                    />
                  </Field>
                </div>

                {newIsDebt && (
                  <Notice kind="info" title={LOCATION_TYPE_LABELS.debt[lang]}>
                    {t('balances.cfgDebtHelp')}
                  </Notice>
                )}

                <UnitSharesEditor units={units} value={newShares} onChange={setNewShares} />

                {/* Balance automático desde la blockchain — solo para wallets.
                    Con una dirección cargada, la ubicación deja de cargarse a
                    mano: el saldo lo pone el cron leyendo la cadena. */}
                {newType === 'wallet' && (
                  <div className="border-t border-border pt-3">
                    <OnchainWalletsEditor value={newOnchain} onChange={setNewOnchain} disabled={creating} />
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[12px] text-text-3">{t('balances.cfgAddHint')}</p>
                  <button
                    type="button"
                    onClick={createCustom}
                    disabled={
                      creating ||
                      !newChannelName.trim() ||
                      (requiresHolder(newType) && !newHolder.trim())
                    }
                    className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-ui-md bg-primary px-4 text-[13px] font-medium text-brand-on-primary hover:bg-primary/90 disabled:opacity-50 [@media(pointer:coarse)]:h-10"
                  >
                    <Plus aria-hidden className="size-[15px]" strokeWidth={1.75} />
                    {creating ? t('balances.cfgAdding') : t('balances.cfgAdd')}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>

        <div className="sticky bottom-0 flex justify-end border-t border-border bg-card px-5 py-3">
          <button type="button" onClick={onClose} className={BTN}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
