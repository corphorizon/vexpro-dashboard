'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Vista del pool de liquidez de la plataforma.
//
// ── POR QUÉ ES UN COMPONENTE Y NO UNA PANTALLA ─────────────────────────────
// La misma vista se entra por dos puertas: el panel de superadmin
// (`/superadmin/liquidity`) y el módulo dentro de la empresa que administra
// (`/liquidez-pool`). Duplicar la pantalla para eso dejaría dos copias que se
// desincronizan en silencio, que es el modo de falla número uno de este repo.
// Las rutas son envoltorios de tres líneas; toda la lógica vive acá.
//
// ── LA DISTINCIÓN QUE LA PANTALLA TIENE QUE DEJAR CLARA ────────────────────
// «Balance MT5» y «Equity a Liquidez» NO son lo mismo, y confundirlos es el
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
import { formatDateTime } from '@/lib/dates';
import { downloadCSV } from '@/lib/csv-export';
import { formatFechaConexion } from '@/lib/liquidity/connection-date';
import { mesLabel, Stat } from './ui';
import { ResumenMensual } from './resumen-mensual';

// Antes acá vivía el UUID de Vex Pro escrito a mano. Se fue: la empresa la
// elige quien mira, porque desde esta pantalla se administran varias. Un ID
// fijo además hacía que la pantalla se viera "vacía" en cualquier otra empresa
// sin decir que estaba mirando la de al lado.
interface Empresa {
  id: string;
  name: string;
  slug: string;
  has_mt5: boolean;
  account_count: number;
}

/** Dónde se recuerda la última empresa elegida, para no re-seleccionarla en
 *  cada visita. Es una comodidad por navegador, no un dato del sistema. */
const CLAVE_EMPRESA = 'liquidity-pool:company-id';

interface Cuenta {
  id: string;
  company_id: string;
  mt5_account: string;
  mt5_email: string | null;
  mt5_group: string | null;
  balance: number;
  equity: number;
  balance_liquidez: number;
  /** El equity a liquidez se cargó a mano y no lo pisa ningún cálculo. */
  liquidez_manual: boolean;
  /** Saldo reconstruido para la fecha de conexión. `null` = no se pudo. */
  equity_at_connection: number | null;
  /** Se cargó a mano; el recálculo automático no lo pisa. */
  connection_values_manual: boolean;
  /** Posiciones abiertas ese día. `null` = no se calculó; `0` = no había. */
  connection_open_positions: number | null;
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

export function LiquidityPoolView({ backHref }: { backHref?: string }) {
  const [empresas, setEmpresas] = useState<Empresa[] | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [cuentas, setCuentas] = useState<Cuenta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vista, setVista] = useState<'cuentas' | 'meses'>('cuentas');
  const [busqueda, setBusqueda] = useState('');
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);

  // Modales
  const [nuevaAbierta, setNuevaAbierta] = useState(false);
  const [detalle, setDetalle] = useState<Cuenta | null>(null);
  const [editando, setEditando] = useState<Cuenta | null>(null);

  // Las empresas se piden una sola vez. La elegida sale de lo último que usó
  // este navegador; si eso ya no existe (empresa dada de baja) se cae a la
  // primera con MT5 configurado, que es la única donde la pantalla puede leer
  // algo. Sin ese respaldo el selector quedaría en una empresa fantasma y la
  // tabla vacía parecería «no hay cuentas».
  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const res = await apiFetch('/api/superadmin/liquidity/companies');
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
        if (!vivo) return;
        const lista: Empresa[] = json.companies ?? [];
        setEmpresas(lista);

        const guardada = typeof window !== 'undefined' ? localStorage.getItem(CLAVE_EMPRESA) : null;
        const elegida =
          lista.find((e) => e.id === guardada) ??
          lista.find((e) => e.has_mt5 && e.account_count > 0) ??
          lista.find((e) => e.has_mt5) ??
          lista[0];
        setCompanyId(elegida?.id ?? null);
      } catch (err) {
        if (!vivo) return;
        setError(err instanceof Error ? err.message : 'Error cargando empresas');
        setEmpresas([]);
      }
    })();
    return () => { vivo = false; };
  }, []);

  const cargar = useCallback(async () => {
    if (!companyId) return;
    try {
      const res = await apiFetch(`/api/superadmin/liquidity/accounts?company_id=${companyId}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      setCuentas(json.accounts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error cargando cuentas');
      setCuentas([]);
    }
  }, [companyId]);

  // Al cambiar de empresa la tabla vuelve a `null` (=«cargando») antes de pedir.
  // Si se quedaran las filas de la anterior, se leerían como si fueran de la
  // nueva durante el instante que tarda la respuesta.
  useEffect(() => {
    if (!companyId) return;
    setCuentas(null);
    void cargar();
  }, [companyId, cargar]);

  const empresaActual = useMemo(
    () => (empresas ?? []).find((e) => e.id === companyId) ?? null,
    [empresas, companyId],
  );

  function elegirEmpresa(id: string) {
    setCompanyId(id);
    setBusqueda('');
    try { localStorage.setItem(CLAVE_EMPRESA, id); } catch { /* modo privado */ }
  }

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
      const res = await apiFetch(`/api/superadmin/liquidity/refresh-all?company_id=${companyId}`, { method: 'POST' });
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
    const headers = ['Cuenta', 'Usuario', 'Grupo', 'Equity a la conexion', 'Origen equity conexion', 'Balance MT5', 'Equity a Liquidez', 'Equity', 'Status', 'Fecha conexion', 'Ultima actualizacion', 'Nota'];
    const rows = filtradas.map((c) => [
      c.mt5_account, c.mt5_email ?? '', c.mt5_group ?? '',
      c.equity_at_connection ?? '', c.connection_values_manual ? 'manual' : (typeof c.connection_open_positions === 'number' && c.connection_open_positions > 0 ? 'calculado (aprox)' : 'calculado'),
      c.balance, c.balance_liquidez, c.equity, c.status,
      c.connection_date ? formatFechaConexion(c.connection_date) : '',
      c.last_synced_at ? formatDateTime(c.last_synced_at) : '',
      c.note ?? '',
    ] as (string | number)[]);
    downloadCSV(`liquidez_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  }

  return (
    <div className="space-y-6">
      {/* El "Volver" sólo existe cuando hay a dónde volver. Entrando por el
          módulo de la empresa, el sidebar ya es la navegación: un enlace al
          panel de superadmin ahí sacaría a la persona de su propio dashboard. */}
      {backHref && (
        <Link href={backHref} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" /> Volver
        </Link>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Droplets className="w-6 h-6 text-[var(--color-secondary)]" /> Liquidez
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Cuentas MT5 que aportan al pool. El <strong>Equity a Liquidez</strong> es lo que hay que
            reservar: si un cliente mueve plata entre cuentas propias, se cuenta una sola vez.
          </p>

          {/* Selector de empresa. Va pegado al título y no escondido en un menú
              porque TODOS los números de abajo dependen de él: leer «$1.2M» sin
              ver de qué empresa es, es peor que no verlo. */}
          <div className="mt-3 flex items-center gap-2">
            <label htmlFor="liq-empresa" className="text-xs font-medium text-muted-foreground">
              Empresa
            </label>
            <select
              id="liq-empresa"
              value={companyId ?? ''}
              onChange={(e) => elegirEmpresa(e.target.value)}
              disabled={!empresas || empresas.length === 0}
              className="h-9 px-2 rounded-lg border border-border bg-card text-sm font-medium disabled:opacity-50 min-w-[14rem]"
            >
              {empresas === null && <option value="">Cargando…</option>}
              {empresas?.length === 0 && <option value="">Sin empresas activas</option>}
              {(empresas ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.has_mt5 ? ` · ${e.account_count}` : ' · sin MT5'}
                </option>
              ))}
            </select>
          </div>
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

      {/* Sin credencial de MT5 la pantalla no puede leer nada, y una tabla
          vacía se lee como «esta empresa no tiene cuentas» cuando lo que pasa
          es que falta configurarla. Se dice cuál es la diferencia. */}
      {empresaActual && !empresaActual.has_mt5 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-warning/10 dark:border-amber-800 text-amber-900 dark:text-amber-100 p-3 text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">{empresaActual.name} no tiene MT5 configurado</p>
            <p className="text-xs mt-0.5">
              No es que no tenga cuentas: sin la credencial de MT5 el módulo no puede leer balances
              ni calcular el PnL. Cargala en Integraciones de esa empresa y volvé.
            </p>
          </div>
        </div>
      )}

      {/* Tabs. "Cuentas" es el estado del pool HOY; "Resumen mensual" es cómo
          rindió mes a mes. Son preguntas distintas y por eso no comparten
          pantalla: mezclarlas obligaría a mirar un total que a veces es un
          saldo y a veces un resultado. */}
      <div className="flex gap-1 border-b border-border">
        {([
          ['cuentas', 'Cuentas'],
          ['meses', 'Resumen mensual'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setVista(id)}
            className={`px-4 h-9 text-sm font-medium border-b-2 -mb-px transition-colors ${
              vista === id
                ? 'border-[var(--color-primary)] text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {vista === 'meses' && companyId && <ResumenMensual companyId={companyId} />}

      {vista === 'cuentas' && (
      <>
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Cuentas" value={String(stats.total)} />
        <Stat label="Activas" value={String(stats.activas)} tone="positive" />
        <Stat label="No activas" value={String(stats.inactivas)} tone="muted" />
        <Stat
          label="Equity a Liquidez (pool)"
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
                {/* Va pegada al equity de esa fecha: los dos datos se leen
                    juntos —«conectada el X, con Y»— y separarlos obligaría a
                    abrir el detalle para saber a qué día corresponde el monto. */}
                <th className="text-left py-2.5 px-3 font-medium">Conectada</th>
                <th className="text-right py-2.5 px-3 font-medium">Equity a la conexión</th>
                <th className="text-right py-2.5 px-3 font-medium">Balance MT5</th>
                <th className="text-right py-2.5 px-3 font-medium">Equity a Liquidez</th>
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
                  <td className="py-2 px-3 tabular-nums">
                    {formatFechaConexion(c.connection_date) || '—'}
                  </td>
                  {/* El saldo QUE TENÍA el día que entró al pool, reconstruido
                      desde MT5. `null` es «no se pudo calcular», que no es cero
                      — por eso va un guion y no un $0,00. */}
                  <td className="py-2 px-3 text-right tabular-nums">
                    {c.equity_at_connection === null || c.equity_at_connection === undefined
                      ? <span className="text-muted-foreground">—</span>
                      : formatCurrency(c.equity_at_connection)}
                    {c.connection_values_manual && (
                      <span
                        className="block text-[11px] font-normal text-muted-foreground"
                        title="Valor cargado a mano. El recálculo automático no lo pisa."
                      >
                        manual
                      </span>
                    )}
                    {/* Con posiciones abiertas ese día el equity real era otro y
                        no se puede reconstruir: se avisa en vez de presentar una
                        aproximación como si fuera exacta. */}
                    {!c.connection_values_manual
                      && typeof c.connection_open_positions === 'number'
                      && c.connection_open_positions > 0 && (
                      <span
                        className="block text-[11px] font-normal text-warning"
                        title={`Había ${c.connection_open_positions} posición(es) abierta(s): es el balance, no el equity.`}
                      >
                        aprox.
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">{formatCurrency(c.balance)}</td>
                  <td className="py-2 px-3 text-right tabular-nums font-medium">
                    {formatCurrency(c.balance_liquidez)}
                    {c.liquidez_manual && (
                      <span
                        className="block text-[11px] font-normal text-muted-foreground"
                        title="Monto cargado a mano."
                      >
                        manual
                      </span>
                    )}
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
      </>
      )}

      {nuevaAbierta && companyId && (
        <ModalNuevaCuenta
          companyId={companyId}
          onClose={() => setNuevaAbierta(false)}
          onDone={async (msg) => { setNuevaAbierta(false); await cargar(); setAviso(msg); }}
        />
      )}
      {detalle && <ModalDetalle cuenta={detalle} onClose={() => setDetalle(null)} />}
      {editando && (
        <ModalNota
          cuenta={editando}
          onClose={() => setEditando(null)}
          onDone={async (aviso) => {
            setEditando(null);
            await cargar();
            setAviso(aviso ?? { tipo: 'ok', texto: 'Cambios guardados.' });
          }}
        />
      )}
    </div>
  );
}

// ─── Piezas ────────────────────────────────────────────────────────────────

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

function ModalNuevaCuenta({ companyId, onClose, onDone }: {
  /** La empresa llega por props y no se vuelve a elegir acá: el alta tiene que
   *  caer sí o sí en la que se está mirando. Un segundo selector adentro del
   *  modal permitiría guardar la cuenta en una empresa distinta de la de la
   *  tabla, y el error recién se vería al refrescar. */
  companyId: string;
  onClose: () => void;
  onDone: (aviso: { tipo: 'ok' | 'error'; texto: string }) => void;
}) {
  const [cuenta, setCuenta] = useState('');
  // Arranca en hoy, que es el caso normal. Se puede correr hacia atrás para dar
  // de alta una cuenta que ya venía operando y recuperarle la historia.
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const hoy = new Date().toISOString().slice(0, 10);
  const retroactiva = fecha < hoy;

  async function guardar() {
    const v = cuenta.trim();
    if (!/^\d+$/.test(v)) { setErr('El número de cuenta debe ser numérico.'); return; }
    if (!fecha) { setErr('Elegí la fecha de conexión.'); return; }
    setGuardando(true);
    setErr(null);
    try {
      const res = await apiFetch('/api/superadmin/liquidity/accounts', {
        method: 'POST',
        body: JSON.stringify({ mt5_account: v, company_id: companyId, connection_date: fecha }),
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
      <label className="block text-sm font-medium mt-4 mb-1.5">Fecha de conexión</label>
      <input
        type="date"
        value={fecha}
        max={hoy}
        onChange={(e) => setFecha(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
      />
      <p className="mt-1.5 text-xs text-muted-foreground">
        Desde cuándo esta cuenta cuenta para el pool. El PnL mes a mes se calcula a partir de acá.
      </p>

      {/* Sólo cuando la fecha es vieja: en el caso normal este texto sería
          ruido, y avisar de algo que no está pasando enseña a ignorar avisos. */}
      {retroactiva && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300 bg-warning/10 dark:border-amber-800 text-amber-900 dark:text-amber-100 p-2.5 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Alta retroactiva</p>
            <p className="mt-0.5">
              El PnL se va a calcular desde esa fecha. El <strong>balance al conectar</strong>, en
              cambio, se guarda con el valor de HOY: MT5 no expone el balance histórico. Para
              validar la historia mirá el PnL mes a mes, no ese campo.
            </p>
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        El resto se completa solo: usuario, grupo, balance y equity salen de MT5. Si el cliente ya
        tiene otra cuenta en el pool, se analiza si el dinero ya estaba contado.
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

function ModalNota({ cuenta, onClose, onDone }: {
  cuenta: Cuenta;
  onClose: () => void;
  onDone: (aviso?: { tipo: 'ok' | 'error'; texto: string }) => void;
}) {
  const [nota, setNota] = useState(cuenta.note ?? '');
  const fechaOriginal = cuenta.connection_date.slice(0, 10);
  const [fecha, setFecha] = useState(fechaOriginal);
  // Vacío = «que lo calcule MT5». Se distingue de un 0 escrito a propósito.
  const equityOriginal =
    cuenta.equity_at_connection === null || cuenta.equity_at_connection === undefined
      ? ''
      : String(cuenta.equity_at_connection);
  const [equity, setEquity] = useState(equityOriginal);

  const liquidezOriginal =
    cuenta.balance_liquidez === null || cuenta.balance_liquidez === undefined
      ? ''
      : String(cuenta.balance_liquidez);
  const [liquidez, setLiquidez] = useState(liquidezOriginal);
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const hoy = new Date().toISOString().slice(0, 10);
  const cambioFecha = fecha !== fechaOriginal;

  async function guardar() {
    if (!fecha) { setErr('Elegí la fecha de conexión.'); return; }
    setGuardando(true);
    setErr(null);
    try {
      const res = await apiFetch(`/api/superadmin/liquidity/accounts/${cuenta.id}`, {
        method: 'PATCH',
        // Sólo se mandan los campos que REALMENTE cambiaron.
        //
        // Mandarlos siempre tenía un efecto que no se veía: el campo llegaba
        // precargado con el valor guardado, y apretar «Guardar» lo reenviaba
        // como si alguien lo hubiera escrito — la cuenta quedaba marcada
        // «manual» sin que nadie tocara el número, y eso bloquea el recálculo
        // automático. Guardar el formulario no es editar el campo.
        body: JSON.stringify({
          note: nota.trim() || null,
          ...(fecha !== fechaOriginal ? { connection_date: fecha } : {}),
          // Cadena vacía = soltar el valor manual y volver al calculado. Es
          // distinto de no mandar el campo, que significa «no lo toques».
          ...(equity.trim() !== equityOriginal
            ? { equity_at_connection: equity.trim() === '' ? null : equity.trim() }
            : {}),
          ...(liquidez.trim() !== liquidezOriginal
            ? { balance_liquidez: liquidez.trim() === '' ? null : liquidez.trim() }
            : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      // El recálculo se avisa con el número de meses: cambiar una fecha y no
      // ver nada moverse dejaría la duda de si el PnL se rehizo o no.
      onDone(
        json.monthsRecalculated !== null && json.monthsRecalculated !== undefined
          ? { tipo: 'ok', texto: `Fecha actualizada. PnL recalculado: ${json.monthsRecalculated} mes/es.` }
          : undefined,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Error al guardar');
      setGuardando(false);
    }
  }

  return (
    <Modal title={`Editar cuenta ${cuenta.mt5_account}`} onClose={onClose}>
      <label className="block text-sm font-medium mb-1.5">Fecha de conexión</label>
      <input
        type="date"
        value={fecha}
        max={hoy}
        onChange={(e) => setFecha(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
      />

      {cambioFecha && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300 bg-warning/10 dark:border-amber-800 text-amber-900 dark:text-amber-100 p-2.5 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Se va a recalcular el PnL mes a mes</p>
            <p className="mt-0.5">
              El PnL guardado se borra y se vuelve a pedir a MT5 con la fecha nueva. Puede tardar
              unos segundos. Si MT5 no responde, la fecha <strong>no</strong> se cambia y queda
              todo como está.
            </p>
          </div>
        </div>
      )}

      <label className="block text-sm font-medium mt-4 mb-1.5">Equity MT5 a la fecha de conexión</label>
      <input
        type="text"
        inputMode="decimal"
        value={equity}
        onChange={(e) => setEquity(e.target.value)}
        placeholder="Se calcula solo desde MT5"
        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
      />
      <p className="mt-1.5 text-xs text-muted-foreground">
        {cuenta.connection_values_manual
          ? 'Cargado a mano. Vaciá el campo para que vuelva a calcularse solo desde MT5.'
          : 'Se reconstruye desde MT5 restándole al saldo de hoy todo lo que se movió después. Escribilo sólo si tenés el número real y el calculado no sirve.'}
      </p>

      {/* Sólo cuando el calculado es una aproximación. Decirlo siempre
          enseñaría a ignorar el aviso. */}
      {!cuenta.connection_values_manual
        && typeof cuenta.connection_open_positions === 'number'
        && cuenta.connection_open_positions > 0 && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-300 bg-warning/10 dark:border-amber-800 text-amber-900 dark:text-amber-100 p-2.5 text-xs">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">
              Había {cuenta.connection_open_positions} posición(es) abierta(s) ese día
            </p>
            <p className="mt-0.5">
              El número de arriba es el <strong>balance</strong>. El equity incluía además el
              flotante de esas posiciones, y MT5 no guarda el precio de ese momento — no se puede
              reconstruir. Si tenés el equity real del reporte, escribilo acá.
            </p>
          </div>
        </div>
      )}

      <label className="block text-sm font-medium mt-4 mb-1.5">Equity a Liquidez</label>
      <input
        type="text"
        inputMode="decimal"
        value={liquidez}
        onChange={(e) => setLiquidez(e.target.value)}
        placeholder="Lo decide el análisis de duplicados"
        className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-secondary)]"
      />
      <p className="mt-1.5 text-xs text-muted-foreground">
        {cuenta.liquidez_manual
          ? 'Cargado a mano. Vaciá el campo para volver a lo que calculó el análisis de duplicados.'
          : 'Cuánto aporta esta cuenta al pool. Sale del análisis de duplicados: si el cliente movió plata entre cuentas propias, se cuenta una sola vez. Editalo si sabés el monto real que se envió.'}
      </p>

      <label className="block text-sm font-medium mt-4 mb-1.5">Nota</label>
      <textarea
        value={nota}
        onChange={(e) => setNota(e.target.value)}
        rows={4}
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
          {guardando ? (cambioFecha ? 'Recalculando PnL…' : 'Guardando…') : 'Guardar'}
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
        <Campo label="Equity a Liquidez" value={formatCurrency(cuenta.balance_liquidez)} />
        <Campo
          label="Equity a la conexión"
          value={
            cuenta.equity_at_connection === null || cuenta.equity_at_connection === undefined
              ? '—'
              : formatCurrency(cuenta.equity_at_connection)
              + (cuenta.connection_values_manual
                ? ' (manual)'
                : typeof cuenta.connection_open_positions === 'number' && cuenta.connection_open_positions > 0
                  ? ' (aprox.)'
                  : '')
          }
        />
        <Campo label="Equity" value={formatCurrency(cuenta.equity)} />
        <Campo label="Conectada" value={formatFechaConexion(cuenta.connection_date)} />
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
