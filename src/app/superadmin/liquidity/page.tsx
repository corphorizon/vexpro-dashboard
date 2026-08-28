'use client';

// ─────────────────────────────────────────────────────────────────────────────
// /superadmin/liquidity — pool de liquidez de la plataforma.
//
// ── LA DISTINCIÓN QUE LA PANTALLA TIENE QUE DEJAR CLARA ────────────────────
// «Balance MT5» y «Balance Liquidez» NO son lo mismo, y confundirlos es el
// error que este módulo existe para evitar. El primero es lo que el cliente
// tiene en su cuenta; el segundo es lo que Horizon debe reservar. Si un cliente
// mueve plata entre dos cuentas propias, el balance MT5 aparece dos veces pero
// el aporte al pool se cuenta UNA.
//
// Por eso van en columnas separadas, con el total del pool destacado y el de
// MT5 al lado como referencia. Mostrar sólo uno haría que el número pareciera
// mal calculado.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Droplets, Plus, RefreshCw, Download, Search, Eye, Pencil, Trash2,
  ArrowLeft, AlertTriangle, X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { formatCurrency } from '@/lib/utils';
import { formatDate, formatDateTime } from '@/lib/dates';
import { downloadCSV } from '@/lib/csv-export';

const VEXPRO_ID = '71715987-5479-52c4-a990-c414fb3a9b36';

interface Cuenta {
  id: string;
  company_id: string;
  mt5_account: string;
  mt5_email: string | null;
  mt5_group: string | null;
  balance: number;
  equity: number;
  balance_liquidez: number;
  connection_date: string;
  status: 'active' | 'inactive' | 'error';
  note: string | null;
  has_multiple_accounts_warning: boolean;
  deactivated_reason: string | null;
  sync_error: string | null;
  last_synced_at: string | null;
}

interface MesPnl {
  year: number;
  month: number;
  pnl: number;
  operations_count: number;
  is_partial: boolean;
}

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const mesLabel = (y: number, m: number) => `${MESES[m - 1] ?? m} ${String(y).slice(2)}`;

export default function LiquidezPage() {
  const [cuentas, setCuentas] = useState<Cuenta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);

  // Modales
  const [nuevaAbierta, setNuevaAbierta] = useState(false);
  const [detalle, setDetalle] = useState<Cuenta | null>(null);
  const [editando, setEditando] = useState<Cuenta | null>(null);

  const cargar = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/superadmin/liquidity/accounts?company_id=${VEXPRO_ID}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setCuentas(json.accounts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando cuentas');
      setCuentas([]);
    }
  }, []);

  useEffect(() => { void cargar(); }, [cargar]);

  // El aviso se va solo: es confirmación, no algo que haya que despachar.
  useEffect(() => {
    if (!aviso) return;
    const id = setTimeout(() => setAviso(null), 8000);
    return () => clearTimeout(id);
  }, [aviso]);

  const filtradas = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    const todas = cuentas ?? [];
    if (!q) return todas;
    return todas.filter((c) =>
      [c.mt5_account, c.mt5_email, c.mt5_group, c.note].some((v) =>
        String(v ?? '').toLowerCase().includes(q),
      ),
    );
  }, [cuentas, busqueda]);

  const stats = useMemo(() => {
    const t = cuentas ?? [];
    return {
      total: t.length,
      activas: t.filter((c) => c.status === 'active').length,
      inactivas: t.filter((c) => c.status !== 'active').length,
      // El del pool es el que manda; el de MT5 va al lado como referencia.
      pool: t.reduce((s, c) => s + (Number(c.balance_liquidez) || 0), 0),
      mt5: t.reduce((s, c) => s + (Number(c.balance) || 0), 0),
    };
  }, [cuentas]);

  async function refrescarTodo() {
    setOcupado('all');
    try {
      const res = await apiFetch(`/api/superadmin/liquidity/refresh-all?company_id=${VEXPRO_ID}`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      await cargar();
      setAviso({
        tipo: 'ok',
        texto: `${json.refreshed} refrescada(s), ${json.failed} con error.` +
          (json.warnings?.length ? ` ${json.warnings.join(' · ')}` : ''),
      });
    } catch (err) {
      setAviso({ tipo: 'error', texto: err instanceof Error ? err.message : 'Error al refrescar' });
    } finally {
      setOcupado(null);
    }
  }

  async function refrescarUna(id: string) {
    setOcupado(id);
    try {
      const res = await apiFetch(`/api/superadmin/liquidity/accounts/${id}/refresh`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      await cargar();
      setAviso({ tipo: 'ok', texto: `Cuenta refrescada · ${json.monthsCalculated} mes(es) de PnL.` });
    } catch (err) {
      setAviso({ tipo: 'error', texto: err instanceof Error ? err.message : 'Error al refrescar' });
    } finally {
      setOcupado(null);
    }
  }

  async function eliminar(c: Cuenta) {
    if (!window.confirm(`¿Sacar la cuenta ${c.mt5_account} del pool?\n\nSe borra también su historial de PnL mensual.`)) return;
    setOcupado(c.id);
    try {
      const res = await apiFetch(`/api/superadmin/liquidity/accounts/${c.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      await cargar();
      setAviso({ tipo: 'ok', texto: `Cuenta ${c.mt5_account} eliminada.` });
    } catch (err) {
      setAviso({ tipo: 'error', texto: err instanceof Error ? err.message : 'Error al eliminar' });
    } finally {
      setOcupado(null);
    }
  }

  function exportarCsv() {
    const headers = ['Cuenta', 'Usuario', 'Grupo', 'Balance MT5', 'Balance Liquidez', 'Equity', 'Status', 'Fecha conexion', 'Ultima actualizacion', 'Nota'];
    const rows = filtradas.map((c) => [
      c.mt5_account, c.mt5_email ?? '', c.mt5_group ?? '',
      c.balance, c.balance_liquidez, c.equity, c.status,
      c.connection_date ? formatDate(c.connection_date) : '',
      c.last_synced_at ? formatDateTime(c.last_synced_at) : '',
      c.note ?? '',
    ] as (string | number)[]);
    downloadCSV(`liquidez_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  }

  return (
    <div className="space-y-6">
      <Link href="/superadmin" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4" /> Volver
      </Link>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Droplets className="w-6 h-6 text-[var(--color-secondary)]" /> Liquidez
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cuentas MT5 que aportan al pool. El <strong>Balance Liquidez</strong> es lo que hay que
            reservar: si un cliente mueve plata entre cuentas propias, se cuenta una sola vez.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={exportarCsv}
            disabled={!cuentas || cuentas.length === 0}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <Download className="w-4 h-4" /> CSV
          </button>
          <button
            onClick={refrescarTodo}
            disabled={ocupado !== null}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${ocupado === 'all' ? 'animate-spin' : ''}`} />
            {ocupado === 'all' ? 'Refrescando…' : 'Refrescar todo'}
          </button>
          <button
            onClick={() => setNuevaAbierta(true)}
            className="inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:opacity-90"
          >
            <Plus className="w-4 h-4" /> Agregar cuenta
          </button>
        </div>
      </div>

      {aviso && (
        <div className={`flex items-start gap-2 rounded-lg p-3 text-sm ${
          aviso.tipo === 'error' ? 'bg-negative/10 text-negative' : 'bg-positive/10 text-positive'
        }`}>
          <span className="flex-1">{aviso.texto}</span>
          <button onClick={() => setAviso(null)} aria-label="Cerrar"><X className="w-4 h-4" /></button>
        </div>
      )}
      {error && (
        <div className="rounded-lg bg-negative/10 text-negative p-3 text-sm">{error}</div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Cuentas" value={String(stats.total)} />
        <Stat label="Activas" value={String(stats.activas)} tone="positive" />
        <Stat label="No activas" value={String(stats.inactivas)} tone="muted" />
        <Stat
          label="Balance Liquidez (pool)"
          value={formatCurrency(stats.pool)}
          sub={`Balance MT5: ${formatCurrency(stats.mt5)}`}
          tone="primary"
        />
      </div>

      {/* Buscador */}
      <div className="relative sm:w-80">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar por cuenta, usuario, grupo o nota…"
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-border bg-card text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
        />
      </div>

      {/* Tabla */}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {cuentas === null ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Cargando…</div>
        ) : filtradas.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {cuentas.length === 0
              ? 'Todavía no hay cuentas en el pool. Agregá la primera con «Agregar cuenta».'
              : 'Sin resultados para la búsqueda.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-muted-foreground">
                <th className="text-left py-2.5 px-3 font-medium">#</th>
                <th className="text-left py-2.5 px-3 font-medium">Cuenta</th>
                <th className="text-left py-2.5 px-3 font-medium">Usuario</th>
                <th className="text-left py-2.5 px-3 font-medium">Grupo</th>
                <th className="text-right py-2.5 px-3 font-medium">Balance MT5</th>
                <th className="text-right py-2.5 px-3 font-medium">Balance Liquidez</th>
                <th className="text-left py-2.5 px-3 font-medium">Status</th>
                <th className="text-left py-2.5 px-3 font-medium">Actualizado</th>
                <th className="text-right py-2.5 px-3 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtradas.map((c, i) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="py-2 px-3 text-muted-foreground">{i + 1}</td>
                  <td className="py-2 px-3 font-medium tabular-nums">
                    {c.mt5_account}
                    {c.has_multiple_accounts_warning && (
                      <span title="El cliente tiene varias cuentas y no se detectó transferencia">
                        <AlertTriangle className="inline w-3.5 h-3.5 ml-1.5 text-warning" />
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-muted-foreground">{c.mt5_email ?? '—'}</td>
                  <td className="py-2 px-3 text-muted-foreground">{c.mt5_group ?? '—'}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(c.balance)}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-medium">
                    {formatCurrency(c.balance_liquidez)}
                    {/* Cuando difieren, el porqué no es obvio: se marca para
                        que nadie lo lea como un error de cálculo. */}
                    {Number(c.balance_liquidez) !== Number(c.balance) && (
                      <span className="block text-[11px] font-normal text-muted-foreground">
                        ≠ MT5
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      c.status === 'active' ? 'bg-positive/10 text-positive'
                        : c.status === 'error' ? 'bg-negative/10 text-negative'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      {c.status === 'active' ? 'Activa' : c.status === 'error' ? 'Error' : 'No activa'}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {c.last_synced_at ? formatDateTime(c.last_synced_at) : '—'}
                  </td>
                  <td className="py-2 px-3">
                    <div className="flex items-center justify-end gap-1">
                      <IconBtn title="Ver detalle" onClick={() => setDetalle(c)}><Eye className="w-4 h-4" /></IconBtn>
                      <IconBtn title="Editar nota" onClick={() => setEditando(c)}><Pencil className="w-4 h-4" /></IconBtn>
                      <IconBtn title="Refrescar" disabled={ocupado !== null} onClick={() => refrescarUna(c.id)}>
                        <RefreshCw className={`w-4 h-4 ${ocupado === c.id ? 'animate-spin' : ''}`} />
                      </IconBtn>
                      <IconBtn title="Eliminar" danger disabled={ocupado !== null} onClick={() => eliminar(c)}>
                        <Trash2 className="w-4 h-4" />
                      </IconBtn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {nuevaAbierta && (
        <ModalNuevaCuenta
          onClose={() => setNuevaAbierta(false)}
          onDone={async (msg) => { setNuevaAbierta(false); await cargar(); setAviso(msg); }}
        />
      )}
      {detalle && <ModalDetalle cuenta={detalle} onClose={() => setDetalle(null)} />}
      {editando && (
        <ModalNota
          cuenta={editando}
          onClose={() => setEditando(null)}
          onDone={async () => { setEditando(null); await cargar(); setAviso({ tipo: 'ok', texto: 'Nota guardada.' }); }}
        />
      )}
    </div>
  );
}

// ─── Piezas ────────────────────────────────────────────────────────────────

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: 'positive' | 'muted' | 'primary';
}) {
  const color = tone === 'positive' ? 'text-positive'
    : tone === 'muted' ? 'text-muted-foreground'
    : tone === 'primary' ? 'text-[var(--color-primary)]' : '';
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-xl font-bold mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function IconBtn({ children, title, onClick, disabled, danger }: {
  children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean; danger?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`p-1.5 rounded-lg hover:bg-muted disabled:opacity-40 ${danger ? 'text-negative hover:bg-negative/10' : 'text-muted-foreground hover:text-foreground'}`}
    >
      {children}
    </button>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Cerrar"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function ModalNuevaCuenta({ onClose, onDone }: {
  onClose: () => void;
  onDone: (aviso: { tipo: 'ok' | 'error'; texto: string }) => void;
}) {
  const [cuenta, setCuenta] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function guardar() {
    const v = cuenta.trim();
    if (!/^\d+$/.test(v)) { setErr('El número de cuenta debe ser numérico.'); return; }
    setGuardando(true);
    setErr(null);
    try {
      const res = await apiFetch('/api/superadmin/liquidity/accounts', {
        method: 'POST',
        body: JSON.stringify({ mt5_account: v, company_id: VEXPRO_ID }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      const w = (json.warnings ?? []) as string[];
      onDone({
        tipo: w.length > 0 ? 'error' : 'ok',
        texto: `Cuenta ${v} agregada (${json.escenario}, ${json.monthsCalculated} mes/es de PnL).`
          + (w.length > 0 ? ` Avisos: ${w.join(' · ')}` : ''),
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error al agregar');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal title="Agregar cuenta al pool" onClose={onClose}>
      <label className="block text-sm font-medium mb-1.5">Número de cuenta MT5</label>
      <input
        autoFocus
        value={cuenta}
        onChange={(e) => setCuenta(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !guardando) void guardar(); }}
        placeholder="146059"
        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
      />
      <p className="mt-2 text-xs text-muted-foreground">
        El resto se completa solo: usuario, grupo, balance y equity salen de MT5, y el PnL mes a mes
        se calcula desde hoy. Si el cliente ya tiene otra cuenta en el pool, se analiza si el dinero
        ya estaba contado.
      </p>
      {err && <p className="mt-2 text-sm text-negative">{err}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="h-9 px-3 rounded-lg border border-border text-sm">Cancelar</button>
        <button
          onClick={() => void guardar()}
          disabled={guardando}
          className="h-9 px-4 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium disabled:opacity-60"
        >
          {guardando ? 'Consultando MT5…' : 'Agregar'}
        </button>
      </div>
    </Modal>
  );
}

function ModalNota({ cuenta, onClose, onDone }: { cuenta: Cuenta; onClose: () => void; onDone: () => void }) {
  const [nota, setNota] = useState(cuenta.note ?? '');
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function guardar() {
    setGuardando(true);
    try {
      const res = await apiFetch(`/api/superadmin/liquidity/accounts/${cuenta.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ note: nota.trim() || null }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error al guardar');
      setGuardando(false);
    }
  }

  return (
    <Modal title={`Nota — cuenta ${cuenta.mt5_account}`} onClose={onClose}>
      <textarea
        autoFocus
        value={nota}
        onChange={(e) => setNota(e.target.value)}
        rows={5}
        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
      />
      {err && <p className="mt-2 text-sm text-negative">{err}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="h-9 px-3 rounded-lg border border-border text-sm">Cancelar</button>
        <button
          onClick={() => void guardar()}
          disabled={guardando}
          className="h-9 px-4 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium disabled:opacity-60"
        >
          {guardando ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
    </Modal>
  );
}

function ModalDetalle({ cuenta, onClose }: { cuenta: Cuenta; onClose: () => void }) {
  const [meses, setMeses] = useState<MesPnl[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(`/api/superadmin/liquidity/accounts/${cuenta.id}/monthly-pnl`);
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
        setMeses(json.months);
        setTotal(json.total);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Error cargando el PnL');
        setMeses([]);
      }
    })();
  }, [cuenta.id]);

  return (
    <Modal title={`Cuenta ${cuenta.mt5_account}`} onClose={onClose}>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
        <Campo label="Usuario" value={cuenta.mt5_email ?? '—'} />
        <Campo label="Grupo" value={cuenta.mt5_group ?? '—'} />
        <Campo label="Status" value={cuenta.status} />
        <Campo label="Balance MT5" value={formatCurrency(cuenta.balance)} />
        <Campo label="Balance Liquidez" value={formatCurrency(cuenta.balance_liquidez)} />
        <Campo label="Equity" value={formatCurrency(cuenta.equity)} />
        <Campo label="Conectada" value={formatDate(cuenta.connection_date)} />
        <Campo label="Actualizada" value={cuenta.last_synced_at ? formatDateTime(cuenta.last_synced_at) : '—'} />
      </dl>

      {Number(cuenta.balance_liquidez) !== Number(cuenta.balance) && (
        <p className="mt-3 rounded-lg bg-muted p-2 text-xs text-muted-foreground">
          El aporte al pool difiere del balance de MT5: parte de este dinero ya estaba contado
          en otra cuenta del mismo cliente.
        </p>
      )}
      {cuenta.has_multiple_accounts_warning && (
        <p className="mt-2 rounded-lg bg-warning/10 p-2 text-xs text-warning">
          El cliente tiene otra(s) cuenta(s) en el pool y no se detectó transferencia entre ellas.
          Verificar que el dinero no esté contado dos veces.
        </p>
      )}
      {cuenta.deactivated_reason && (
        <p className="mt-2 text-xs text-muted-foreground">Desactivada: {cuenta.deactivated_reason}</p>
      )}
      {cuenta.sync_error && (
        <p className="mt-2 rounded-lg bg-negative/10 p-2 text-xs text-negative">Error de sincronización: {cuenta.sync_error}</p>
      )}
      {cuenta.note && <p className="mt-2 text-xs text-muted-foreground">Nota: {cuenta.note}</p>}

      <h3 className="mt-5 text-sm font-semibold">Historial de PnL mensual</h3>
      {err && <p className="mt-2 text-sm text-negative">{err}</p>}
      {meses === null ? (
        <p className="mt-2 text-sm text-muted-foreground">Cargando…</p>
      ) : meses.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">Sin PnL calculado todavía.</p>
      ) : (
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th className="text-left py-1.5 font-medium">Mes</th>
              <th className="text-right py-1.5 font-medium">PnL</th>
              <th className="text-right py-1.5 font-medium">Operaciones</th>
              <th className="text-left py-1.5 pl-3 font-medium">Nota</th>
            </tr>
          </thead>
          <tbody>
            {meses.map((m) => (
              <tr key={`${m.year}-${m.month}`} className="border-b border-border last:border-0">
                <td className="py-1.5">{mesLabel(m.year, m.month)}</td>
                <td className={`py-1.5 text-right tabular-nums ${m.pnl < 0 ? 'text-negative' : m.pnl > 0 ? 'text-positive' : ''}`}>
                  {formatCurrency(m.pnl)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{m.operations_count}</td>
                <td className="py-1.5 pl-3 text-xs text-muted-foreground">{m.is_partial ? 'parcial' : ''}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="py-2">Total</td>
              <td className={`py-2 text-right tabular-nums ${total < 0 ? 'text-negative' : 'text-positive'}`}>
                {formatCurrency(total)}
              </td>
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function Campo({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
