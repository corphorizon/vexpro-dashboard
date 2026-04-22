'use client';

// ─────────────────────────────────────────────────────────────────────────────
// ChannelConfigModal
//
// Admin-only "Configurar" panel for the Balances por Canal card. Lets admins:
//   · Toggle every channel's visibility (both built-in and custom).
//   · Rename manual channels (API-sourced ones keep their provider name).
//   · Add brand-new custom channels with an optional initial balance.
//   · Delete custom channels (built-ins can only be hidden).
//
// All persistence happens through /api/admin/channel-configs. After any
// successful mutation we call `onChanged()` so the parent page re-fetches
// the config and re-renders the channel list.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import {
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
  Lock,
  AlertTriangle,
} from 'lucide-react';
import type { ResolvedChannel, ChannelConfigRow } from '@/lib/channel-configs';
import { resolveChannels } from '@/lib/channel-configs';
import { formatCurrency } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after any successful mutation — parent refetches config. */
  onChanged: () => void;
  /** Resolved value for each channel at the currently-viewed date — used
   *  as read-only preview inside the modal. */
  getValue: (channelKey: string) => number;
}

export function ChannelConfigModal({ open, onClose, onChanged, getValue }: Props) {
  const [rows, setRows] = useState<ChannelConfigRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [editingLabelFor, setEditingLabelFor] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelBalance, setNewChannelBalance] = useState('');
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setEditingLabelFor(null);
    setNewChannelName('');
    setNewChannelBalance('');
    setLoading(true);
    (async () => {
      try {
        const res = await fetch('/api/admin/channel-configs');
        const json = (await res.json()) as { success: boolean; rows?: ChannelConfigRow[] };
        if (json.success) setRows(json.rows ?? []);
        else throw new Error('No se pudo cargar la configuración');
      } catch (err) {
        setStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Error' });
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  const resolved: ResolvedChannel[] = resolveChannels(rows);

  async function refresh() {
    const res = await fetch('/api/admin/channel-configs');
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
      const res = await fetch('/api/admin/channel-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upsert', channel_key, ...patch }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? 'Error');
      await refresh();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Error' });
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
      setStatus({ kind: 'err', msg: 'El nombre no puede estar vacío' });
      return;
    }
    await upsert(ch.key, { custom_label: clean });
    setEditingLabelFor(null);
    setLabelDraft('');
  }

  async function createCustom() {
    const clean = newChannelName.trim();
    if (!clean) {
      setStatus({ kind: 'err', msg: 'Nombre requerido' });
      return;
    }
    setCreating(true);
    setStatus(null);
    try {
      const initial = parseFloat(newChannelBalance);
      const res = await fetch('/api/admin/channel-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_custom',
          label: clean,
          initial_balance: isNaN(initial) ? undefined : initial,
        }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? 'Error');
      setNewChannelName('');
      setNewChannelBalance('');
      setStatus({ kind: 'ok', msg: 'Canal creado' });
      await refresh();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Error' });
    } finally {
      setCreating(false);
    }
  }

  async function deleteCustom(ch: ResolvedChannel) {
    if (!ch.isCustom) return;
    if (!confirm(`Eliminar el canal "${ch.label}" y todos sus snapshots?`)) return;
    setSaving(ch.key);
    setStatus(null);
    try {
      const res = await fetch('/api/admin/channel-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', channel_key: ch.key }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? 'Error');
      await refresh();
    } catch (err) {
      setStatus({ kind: 'err', msg: err instanceof Error ? err.message : 'Error' });
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
            <h2 className="text-lg font-semibold">Configurar Balances por Canal</h2>
            <p className="text-xs text-muted-foreground">
              Oculta canales, renombra, o agrega uno propio. Solo los visibles suman al Total Consolidado.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-muted"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {status && (
            <div
              className={`flex items-start gap-2 p-3 rounded-md text-xs ${
                status.kind === 'ok'
                  ? 'bg-emerald-50 border border-emerald-200 text-emerald-700 dark:bg-emerald-950/30 dark:border-emerald-800 dark:text-emerald-300'
                  : 'bg-red-50 border border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-800 dark:text-red-300'
              }`}
            >
              {status.kind === 'err' && <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
              <span>{status.msg}</span>
            </div>
          )}

          {loading ? (
            <p className="text-sm text-muted-foreground">Cargando…</p>
          ) : (
            <>
              <section className="space-y-2">
                <h3 className="text-sm font-medium">Canales</h3>
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
                            ? 'border-emerald-300 text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30'
                            : 'border-muted text-muted-foreground'
                        } disabled:opacity-50`}
                        aria-label={ch.isVisible ? 'Ocultar canal' : 'Mostrar canal'}
                        title={ch.isVisible ? 'Visible — click para ocultar' : 'Oculto — click para mostrar'}
                      >
                        {ch.isVisible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                      </button>

                      <div className="flex-1 min-w-0">
                        {editing ? (
                          <div className="flex items-center gap-2">
                            <input
                              value={labelDraft}
                              onChange={(e) => setLabelDraft(e.target.value)}
                              className="flex-1 px-2 py-1 text-sm rounded border border-border bg-background"
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
                              className="p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 rounded"
                              aria-label="Guardar nombre"
                            >
                              <Save className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => {
                                setEditingLabelFor(null);
                                setLabelDraft('');
                              }}
                              className="p-1 text-muted-foreground hover:bg-muted rounded"
                              aria-label="Cancelar"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-medium truncate">{ch.label}</p>
                              {isApi && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                                  <Lock className="w-2.5 h-2.5" /> API
                                </span>
                              )}
                              {ch.isBuiltin && !isApi && (
                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground border border-border">
                                  Predefinido
                                </span>
                              )}
                              {ch.isCustom && (
                                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-violet-50 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-800">
                                  Personalizado
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">
                              {ch.description} · Balance actual:{' '}
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
                              className="p-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded disabled:opacity-50"
                              title="Renombrar"
                              aria-label="Renombrar"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {ch.isCustom && (
                            <button
                              onClick={() => deleteCustom(ch)}
                              disabled={busy}
                              className="p-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded disabled:opacity-50"
                              title="Eliminar canal"
                              aria-label="Eliminar canal"
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

              {/* Add custom channel */}
              <section className="pt-3 border-t border-border">
                <h3 className="text-sm font-medium mb-2">Agregar canal manual</h3>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_140px_auto] gap-2">
                  <input
                    value={newChannelName}
                    onChange={(e) => setNewChannelName(e.target.value)}
                    placeholder="Nombre (ej. Banco Santander)"
                    className="px-3 py-2 text-sm rounded-md border border-border bg-background"
                  />
                  <input
                    type="number"
                    step="0.01"
                    value={newChannelBalance}
                    onChange={(e) => setNewChannelBalance(e.target.value)}
                    placeholder="Balance inicial"
                    className="px-3 py-2 text-sm rounded-md border border-border bg-background text-right"
                  />
                  <button
                    onClick={createCustom}
                    disabled={creating || !newChannelName.trim()}
                    className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-md bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90 disabled:opacity-50"
                  >
                    <Plus className="w-4 h-4" />
                    {creating ? 'Creando…' : 'Agregar'}
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  El balance inicial se guarda como snapshot de hoy. Luego podés editarlo desde la tarjeta principal con el lápiz como cualquier canal manual.
                </p>
              </section>
            </>
          )}
        </div>

        <div className="p-5 border-t border-border sticky bottom-0 bg-background flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-muted"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
