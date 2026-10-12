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
//
// ── «LIBRO MAYOR» (2026-10-12) ─────────────────────────────────────────────
// Sólo presentación: ningún endpoint, cálculo ni regla L1-L7 cambió.
//   · Cuatro tarjetas `Stat` → UNA franja: Equity a Liquidez (hero) con el
//     Balance MT5 en el sub y como KPI propio, más los conteos.
//   · `<table>` a mano → FinTable: el equity a la conexión lleva «manual» /
//     «aprox.» como metadato (`connectionEquityTag`), el status es un
//     StatusBadge (activa `ok`, error `bad`, no activa neutro) y las acciones
//     de fila aparecen al pasar (siempre en táctil). El pie suma lo que se ve y
//     lo dice cuando hay una búsqueda activa.
//   · Avisos ámbar con `dark:` de paleta cruda → `Notice` (pend/bad/info);
//     formularios de los modales con `Field`; botones con la receta única
//     (`ActionButton`, primario con `text-brand-on-primary`).
//   · Los montos pasan por `toAmount` antes de `<Money>`: el endpoint puede
//     mandarlos como texto y `<Money>` dibujaría «—» sobre un saldo real.
//   · Título «Pool de Liquidez» (el del registro de módulos): «Liquidez» a
//     secas es el otro módulo, el que este archivo pide no confundir.
// DESCARTADO: pasar los textos a i18n en este cambio. La vista nunca usó
// `t()` (se entra también por /superadmin, en castellano); traducirla es otro
// trabajo y mezclarlo acá haría ilegible la revisión del rediseño.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Droplets, Plus, RefreshCw, Download, Search, Eye, Pencil, Trash2,
  ArrowLeft, AlertTriangle, X,
} from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { formatMoney } from '@/lib/money';
import { formatDate, formatDateTime } from '@/lib/dates';
import { downloadCSV } from '@/lib/csv-export';
import { formatFechaConexion } from '@/lib/liquidity/connection-date';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, NUM_CLASS } from '@/components/ui/money';
import { Notice } from '@/components/ui/notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { Segmented } from '@/components/ui/segmented';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ActionButton, actionButtonClass, ROW_ACTION_CLASS } from '@/components/ui/action-button';
import { mesLabel } from './ui';
import { ResumenMensual } from './resumen-mensual';
import {
  connectionEquityTag, differsFromMt5, poolStatusKind, poolTotals, toAmount,
} from './pool-view-model';

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

// ─────────────────────────────────────────────────────────────────────────────
// Cuánto esperan las operaciones que hablan con MT5.
//
// `apiFetch` corta a los 25 s por defecto, y para casi todo el dashboard está
// bien. Acá no: agregar una cuenta abre TRES conexiones a MT5 —los datos de la
// cuenta, el saldo a la fecha de conexión y el PnL mes a mes— y cada una
// levanta su propio túnel SOCKS, porque en serverless no hay pool que
// sobreviva entre invocaciones.
//
// El resultado era el peor de los dos mundos: el navegador abortaba a los 25 s
// y mostraba «signal is aborted without reason», pero el servidor seguía y
// terminaba de crear la cuenta. La operación salía bien y la pantalla decía
// que había fallado.
//
// Estos números siguen a los `maxDuration` de cada endpoint. Si allá cambian,
// acá también: que el cliente corte antes que el servidor es exactamente el
// bug que esto arregla.
// ─────────────────────────────────────────────────────────────────────────────
const ESPERA_MT5_MS = 120_000;
/** `refresh-all` recorre hasta 60 cuentas; su `maxDuration` es 300. */
const ESPERA_REFRESCAR_TODO_MS = 300_000;

/**
 * Si la espera se cortó del lado del navegador.
 *
 * Importa distinguirlo de un error de verdad: acá el servidor probablemente
 * TERMINÓ el trabajo, así que corresponde recargar la lista y decir eso, en vez
 * de dar por fallida una operación que salió bien.
 */
function esAborto(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message));
}

const AVISO_ABORTO =
  'La operación tardó más de lo esperado y se cortó la espera, pero puede haber ' +
  'terminado igual. Se recargó la lista: fijate si ya está.';

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

export function LiquidityPoolView({
  backHref,
  readOnly = false,
}: {
  backHref?: string;
  /**
   * true = usuario de empresa proveedora (2026-10-12): ve el pool pero las
   * mutaciones (agregar, editar, refrescar, borrar) son de superadmin — el
   * server las rechaza con 403, así que acá ni se ofrecen. No es cosmético:
   * un botón que siempre falla es peor que no tener el botón.
   */
  readOnly?: boolean;
}) {
  const [empresas, setEmpresas] = useState<Empresa[] | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [cuentas, setCuentas] = useState<Cuenta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vista, setVista] = useState<'cuentas' | 'meses'>('cuentas');
  const [busqueda, setBusqueda] = useState('');
  const [ocupado, setOcupado] = useState<string | null>(null);
  // Sube en cada «Refrescar todo» que termina: el Resumen mensual carga su
  // lista de meses una sola vez por empresa, y sin esto el mes recién
  // generado no aparecía hasta recargar la página (dueño, 2026-09-28: «le di
  // a refrescar y sigue igual» — las 39 filas de septiembre YA estaban en la
  // base; la pantalla no se había enterado).
  const [refrescoNonce, setRefrescoNonce] = useState(0);
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

  // Los mismos totales de siempre (Σ por cuenta), ahora en `poolTotals` con test.
  const stats = useMemo(() => {
    const t = poolTotals(cuentas ?? []);
    return { total: t.total, activas: t.active, inactivas: t.inactive, pool: t.pool, mt5: t.mt5 };
  }, [cuentas]);

  async function refrescarTodo() {
    setOcupado('all');
    try {
      const res = await apiFetch(
        `/api/superadmin/liquidity/refresh-all?company_id=${companyId}`,
        { method: 'POST', timeoutMs: ESPERA_REFRESCAR_TODO_MS },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      await cargar();
      setRefrescoNonce((n) => n + 1);
      setAviso({
        tipo: 'ok',
        texto: `${json.refreshed} refrescada(s), ${json.failed} con error.` +
          (json.warnings?.length ? ` ${json.warnings.join(' · ')}` : ''),
      });
    } catch (err) {
      // Un aborto no es un fallo: el servidor pudo haber terminado igual —
      // por eso también acá se re-consulta el resumen.
      if (esAborto(err)) { await cargar(); setRefrescoNonce((n) => n + 1); setAviso({ tipo: 'error', texto: AVISO_ABORTO }); }
      else setAviso({ tipo: 'error', texto: err instanceof Error ? err.message : 'Error al refrescar' });
    } finally {
      setOcupado(null);
    }
  }

  async function refrescarUna(id: string) {
    setOcupado(id);
    try {
      const res = await apiFetch(
        `/api/superadmin/liquidity/accounts/${id}/refresh`,
        { method: 'POST', timeoutMs: ESPERA_MT5_MS },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      await cargar();
      setAviso({ tipo: 'ok', texto: `Cuenta refrescada · ${json.monthsCalculated} mes(es) de PnL.` });
    } catch (err) {
      if (esAborto(err)) { await cargar(); setAviso({ tipo: 'error', texto: AVISO_ABORTO }); }
      else setAviso({ tipo: 'error', texto: err instanceof Error ? err.message : 'Error al refrescar' });
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

  const kpis: KpiItem[] = [
    {
      key: 'pool',
      label: 'Equity a Liquidez (pool)',
      value: cuentas === null ? null : stats.pool,
      hero: true,
      // 'money' y no el compact por defecto (dueño, 2026-10-12): el monto a
      // reservar se lee exacto, no "$45.2K" con el dato real escondido en el
      // title. Igual en los KPI del Resumen mensual.
      format: 'money',
      // El del pool es el que manda; el de MT5 va al lado como referencia.
      sub: cuentas === null ? undefined : `Balance MT5: ${formatMoney(stats.mt5)}`,
      missingBadge: cuentas === null ? { kind: 'stale', label: 'Cargando…' } : false,
    },
    { key: 'mt5', label: 'Balance MT5', value: cuentas === null ? null : stats.mt5, format: 'money', missingBadge: false },
    { key: 'total', label: 'Cuentas', value: cuentas === null ? null : stats.total, format: 'count', missingBadge: false },
    { key: 'active', label: 'Activas', value: cuentas === null ? null : stats.activas, format: 'count', missingBadge: false },
    { key: 'inactive', label: 'No activas', value: cuentas === null ? null : stats.inactivas, format: 'count', missingBadge: false },
  ];

  const columnas: FinColumn<Cuenta>[] = [
    {
      key: 'cuenta',
      header: 'Cuenta',
      cell: (c) => (
        <span className={cn(NUM_CLASS, 'inline-flex items-center gap-1.5')}>
          {c.mt5_account}
          {c.has_multiple_accounts_warning && (
            <span title="El cliente tiene varias cuentas y no se detectó transferencia">
              <AlertTriangle aria-label="Varias cuentas sin transferencia detectada" className="size-3.5 text-pend" />
            </span>
          )}
        </span>
      ),
      // Los correos largos se cortan con el valor completo en el title: uno de
      // 40 caracteres estiraba la tabla hasta obligar a desplazarse en
      // horizontal para llegar a los montos, que es lo que la gente viene a mirar.
      meta: (c) => (c.mt5_email ? <span title={c.mt5_email}>{c.mt5_email}</span> : undefined),
      mobileMeta: (c) => (
        <>
          <StatusBadge kind={poolStatusKind(c.status)} label={ESTADO[c.status] ?? c.status} />
          <span className={NUM_CLASS}>{formatFechaConexion(c.connection_date) || '—'}</span>
        </>
      ),
    },
    {
      // Todos los grupos arrancan con `real\`, así que ese prefijo no distingue
      // nada y sólo ocupa lugar. Se muestra el resto y el valor entero queda en el title.
      key: 'grupo',
      header: 'Grupo',
      hideSm: true,
      cell: (c) => (
        <span className="block max-w-[150px] truncate text-text-2" title={c.mt5_group ?? undefined}>
          {c.mt5_group ? c.mt5_group.replace(/^real\\/, '') : '—'}
        </span>
      ),
    },
    {
      // Va pegada al equity de esa fecha: los dos datos se leen juntos
      // —«conectada el X, con Y»— y separarlos obligaría a abrir el detalle.
      key: 'conectada',
      header: 'Conectada',
      hideSm: true,
      cell: (c) => <span className={cn(NUM_CLASS, 'text-text-2')}>{formatFechaConexion(c.connection_date) || '—'}</span>,
    },
    {
      // El saldo QUE TENÍA el día que entró al pool, reconstruido desde MT5.
      // `null` es «no se pudo calcular», que no es cero — por eso «—».
      key: 'equityConexion',
      header: 'Equity conexión',
      kind: 'money',
      hideSm: true,
      value: (c) => toAmount(c.equity_at_connection),
      meta: (c) => {
        const tag = connectionEquityTag(c);
        if (tag === 'manual') return <span title="Valor cargado a mano. El recálculo automático no lo pisa.">manual</span>;
        // Con posiciones abiertas ese día el equity real era otro y no se puede
        // reconstruir: se avisa en vez de presentar una aproximación como exacta.
        if (tag === 'approx') {
          return (
            <span className="text-pend" title={`Había ${c.connection_open_positions} posición(es) abierta(s): es el balance, no el equity.`}>
              aprox.
            </span>
          );
        }
        return undefined;
      },
      subtotal: false,
    },
    { key: 'balance', header: 'Balance MT5', kind: 'money', value: (c) => toAmount(c.balance), hideSm: true },
    {
      key: 'liquidez',
      header: 'Equity a Liquidez',
      kind: 'money',
      value: (c) => toAmount(c.balance_liquidez),
      meta: (c) => {
        const partes = [
          c.liquidez_manual ? 'manual' : null,
          // Cuando difieren, el porqué no es obvio: se marca para que nadie lo
          // lea como un error de cálculo.
          differsFromMt5(c) ? '≠ MT5' : null,
        ].filter(Boolean);
        return partes.length > 0 ? <span title={c.liquidez_manual ? 'Monto cargado a mano.' : undefined}>{partes.join(' · ')}</span> : undefined;
      },
    },
    {
      key: 'status',
      header: 'Status',
      hideSm: true,
      cell: (c) => <StatusBadge kind={poolStatusKind(c.status)} label={ESTADO[c.status] ?? c.status} />,
    },
    {
      // Sólo el día. La hora exacta del último refresco casi nunca se necesita
      // de un vistazo; queda en el title y en el detalle.
      key: 'actualizado',
      header: 'Actualizado',
      hideSm: true,
      cell: (c) => (
        <span className={cn(NUM_CLASS, 'text-text-3')} title={c.last_synced_at ? formatDateTime(c.last_synced_at) : undefined}>
          {c.last_synced_at ? formatDate(c.last_synced_at) : '—'}
        </span>
      ),
    },
  ];

  const filas = filtradas;
  const buscando = busqueda.trim() !== '' && (cuentas?.length ?? 0) !== filtradas.length;
  const totalesFiltradas = poolTotals(filtradas);

  return (
    <div className="space-y-4">
      {/* El "Volver" sólo existe cuando hay a dónde volver. Entrando por el
          módulo de la empresa, el sidebar ya es la navegación: un enlace al
          panel de superadmin ahí sacaría a la persona de su propio dashboard. */}
      {backHref && (
        <Link href={backHref} className={actionButtonClass('ghost')}>
          <ArrowLeft aria-hidden className="size-4" /> Volver
        </Link>
      )}

      <PageHeader
        title="Pool de Liquidez"
        subtitle="Cuentas MT5 que aportan al pool. El Equity a Liquidez es lo que hay que reservar: si un cliente mueve plata entre cuentas propias, se cuenta una sola vez."
        icon={Droplets}
        actions={
          <>
            <ActionButton onClick={exportarCsv} disabled={!cuentas || cuentas.length === 0} aria-label="Exportar CSV">
              <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="hidden sm:inline">CSV</span>
            </ActionButton>
            {!readOnly && (
              <>
                <ActionButton onClick={refrescarTodo} disabled={ocupado !== null} loading={ocupado === 'all'}>
                  {ocupado !== 'all' && <RefreshCw aria-hidden className="size-[15px]" strokeWidth={1.75} />}
                  {ocupado === 'all' ? 'Refrescando…' : 'Refrescar todo'}
                </ActionButton>
                <ActionButton variant="primary" onClick={() => setNuevaAbierta(true)} disabled={!companyId}>
                  <Plus aria-hidden className="size-4" /> Agregar cuenta
                </ActionButton>
              </>
            )}
          </>
        }
      />

      {/* Selector de empresa. Va arriba de todo y no escondido en un menú
          porque TODOS los números de abajo dependen de él: leer «$1.2M» sin
          ver de qué empresa es, es peor que no verlo.
          Las pestañas: "Cuentas" es el estado del pool HOY; "Resumen mensual"
          es cómo rindió mes a mes. Son preguntas distintas y por eso no
          comparten pantalla: mezclarlas obligaría a mirar un total que a veces
          es un saldo y a veces un resultado. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Empresa" className="w-full sm:w-72">
          <Select
            value={companyId ?? ''}
            onChange={(e) => elegirEmpresa(e.target.value)}
            disabled={!empresas || empresas.length === 0}
          >
            {empresas === null && <option value="">Cargando…</option>}
            {empresas?.length === 0 && <option value="">Sin empresas activas</option>}
            {(empresas ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.has_mt5 ? ` · ${e.account_count}` : ' · sin MT5'}
              </option>
            ))}
          </Select>
        </Field>
        <Segmented<'cuentas' | 'meses'>
          aria-label="Vista del pool"
          value={vista}
          onChange={setVista}
          options={[
            { value: 'cuentas', label: 'Cuentas', count: cuentas?.length ?? null },
            { value: 'meses', label: 'Resumen mensual' },
          ]}
        />
      </div>

      {aviso && (
        <Notice
          kind={aviso.tipo === 'error' ? 'bad' : 'info'}
          title={aviso.texto}
          action={
            <button type="button" onClick={() => setAviso(null)} aria-label="Cerrar aviso" className={ROW_ACTION_CLASS}>
              <X aria-hidden className="size-4" />
            </button>
          }
        />
      )}
      {error && <Notice kind="bad" title="No se pudo cargar el pool">{error}</Notice>}

      {/* Sin credencial de MT5 la pantalla no puede leer nada, y una tabla
          vacía se lee como «esta empresa no tiene cuentas» cuando lo que pasa
          es que falta configurarla. Se dice cuál es la diferencia. */}
      {empresaActual && !empresaActual.has_mt5 && (
        <Notice kind="pend" title={`${empresaActual.name} no tiene MT5 configurado`}>
          No es que no tenga cuentas: sin la credencial de MT5 el módulo no puede leer balances
          ni calcular el PnL. Cargala en Integraciones de esa empresa y volvé.
        </Notice>
      )}

      {vista === 'meses' && companyId && <ResumenMensual companyId={companyId} refrescoNonce={refrescoNonce} />}

      {vista === 'cuentas' && (
        <>
          <KpiStrip items={kpis} />

          <Panel
            title="Cuentas del pool"
            hint="Balance MT5 = lo que el cliente tiene · Equity a Liquidez = lo que se reserva"
            flush
            actions={
              <div className="relative w-full min-w-[220px] max-w-[320px] max-sm:max-w-none">
                <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-[15px] -translate-y-1/2 text-text-3" />
                <Input
                  type="search"
                  value={busqueda}
                  onChange={(e) => setBusqueda(e.target.value)}
                  placeholder="Buscar por cuenta, usuario, grupo o nota…"
                  aria-label="Buscar cuentas"
                  className="h-8 pl-8 [@media(pointer:coarse)]:h-10"
                />
              </div>
            }
          >
            {cuentas === null ? (
              <div className="p-4"><Skeleton className="h-40" /></div>
            ) : (
              <FinTable
                caption="Cuentas del pool"
                columns={columnas}
                rows={filas}
                rowKey={(c) => c.id}
                empty={cuentas.length === 0
                  ? (readOnly
                      ? 'Todavía no hay cuentas en el pool.'
                      : 'Todavía no hay cuentas en el pool. Agregá la primera con «Agregar cuenta».')
                  : 'Sin resultados para la búsqueda.'}
                rowActions={(c) => (
                  <>
                    <IconBtn title="Ver detalle" onClick={() => setDetalle(c)}><Eye aria-hidden className="size-4" strokeWidth={1.75} /></IconBtn>
                    {!readOnly && (
                      <>
                        <IconBtn title="Editar" onClick={() => setEditando(c)}><Pencil aria-hidden className="size-4" strokeWidth={1.75} /></IconBtn>
                        <IconBtn title="Refrescar" disabled={ocupado !== null} onClick={() => refrescarUna(c.id)}>
                          <RefreshCw aria-hidden className={cn('size-4', ocupado === c.id && 'animate-spin')} strokeWidth={1.75} />
                        </IconBtn>
                        <IconBtn title="Eliminar" danger disabled={ocupado !== null} onClick={() => eliminar(c)}>
                          <Trash2 aria-hidden className="size-4" strokeWidth={1.75} />
                        </IconBtn>
                      </>
                    )}
                  </>
                )}
                footer={
                  filas.length > 0
                    ? {
                        // Con una búsqueda activa el total es de lo que se ve, y
                        // la etiqueta lo dice: la franja de arriba es de TODAS.
                        label: buscando
                          ? `Total de la búsqueda (${filas.length} de ${cuentas.length} cuentas)`
                          : `Total (${filas.length} cuentas)`,
                        values: { balance: totalesFiltradas.mt5, liquidez: totalesFiltradas.pool },
                      }
                    : undefined
                }
              />
            )}
          </Panel>
        </>
      )}

      {nuevaAbierta && companyId && (
        <ModalNuevaCuenta
          companyId={companyId}
          onClose={() => setNuevaAbierta(false)}
          onDone={async (msg) => {
            setNuevaAbierta(false);
            await cargar();
            setAviso(msg);
            // La cuenta ya está en la tabla. Ahora se pide el histórico en una
            // petición aparte: si ésta falla, la cuenta igual quedó creada y se
            // arregla con el botón de refrescar de su fila.
            if (msg.refrescar) await refrescarUna(msg.refrescar);
          }}
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

const ESTADO: Record<string, string> = { active: 'Activa', error: 'Error', inactive: 'No activa' };

function IconBtn({ children, title, onClick, disabled, danger }: {
  children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean; danger?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(ROW_ACTION_CLASS, danger && 'hover:bg-neg-bg hover:text-neg')}
    >
      {children}
    </button>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // Escape cierra, como en el resto de los diálogos.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim p-4 sm:p-8">
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-2xl rounded-ui-xl border border-border bg-card shadow-3">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.005em]">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Cerrar" className={ROW_ACTION_CLASS}>
            <X aria-hidden className="size-4" />
          </button>
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
  onDone: (aviso: { tipo: 'ok' | 'error'; texto: string; refrescar?: string }) => void;
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
        timeoutMs: ESPERA_MT5_MS,
        body: JSON.stringify({ mt5_account: v, company_id: companyId, connection_date: fecha }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      const w = (json.warnings ?? []) as string[];

      // La cuenta YA está creada. El histórico —saldo a la conexión y PnL mes a
      // mes— lo calcula el refresh, en una petición aparte.
      //
      // Se parte en dos porque juntas tardaban tanto que se perdía el alta
      // entera. Así, si esta segunda falla, la cuenta igual quedó: se ve en la
      // tabla y se arregla con el botón de refrescar.
      onDone({
        tipo: w.length > 0 ? 'error' : 'ok',
        texto: `Cuenta ${v} agregada (${json.escenario}).`
          + (json.historyPending ? ' Calculando su histórico…' : '')
          + (w.length > 0 ? ` Avisos: ${w.join(' · ')}` : ''),
        // El id viaja para que la pantalla sepa a quién refrescar.
        refrescar: json.historyPending ? String(json.account?.id ?? '') : undefined,
      });
    } catch (e) {
      // Con un aborto el alta pudo haber terminado en el servidor, así que se
      // cierra el modal y se recarga la lista. Dejarlo abierto con un error
      // invita a apretar «Agregar» de nuevo sobre una cuenta que ya existe.
      if (esAborto(e)) onDone({ tipo: 'error', texto: AVISO_ABORTO });
      else {
        setErr(e instanceof Error ? e.message : 'Error al agregar');
        setGuardando(false);
      }
      return;
    }
    setGuardando(false);
  }

  return (
    <Modal title="Agregar cuenta al pool" onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!guardando) void guardar(); }}>
        <Field label="Número de cuenta MT5" required error={err ?? undefined}>
          <Input
            autoFocus
            inputMode="numeric"
            value={cuenta}
            onChange={(e) => setCuenta(e.target.value)}
            placeholder="146059"
          />
        </Field>
        <Field
          label="Fecha de conexión"
          required
          hint="Desde cuándo esta cuenta cuenta para el pool. El PnL mes a mes se calcula a partir de acá."
        >
          <Input type="date" value={fecha} max={hoy} onChange={(e) => setFecha(e.target.value)} />
        </Field>

        {/* Sólo cuando la fecha es vieja: en el caso normal este texto sería
            ruido, y avisar de algo que no está pasando enseña a ignorar avisos. */}
        {retroactiva && (
          <Notice kind="pend" title="Alta retroactiva">
            El PnL se va a calcular desde esa fecha. El <strong>balance al conectar</strong>, en
            cambio, se guarda con el valor de HOY: MT5 no expone el balance histórico. Para
            validar la historia mirá el PnL mes a mes, no ese campo.
          </Notice>
        )}

        <p className="text-[12.5px] text-text-3">
          El resto se completa solo: usuario, grupo, balance y equity salen de MT5. Si el cliente ya
          tiene otra cuenta en el pool, se analiza si el dinero ya estaba contado.
        </p>
        <div className="flex justify-end gap-2">
          <ActionButton onClick={onClose}>Cancelar</ActionButton>
          <ActionButton type="submit" variant="primary" loading={guardando}>
            {guardando ? 'Consultando MT5…' : 'Agregar'}
          </ActionButton>
        </div>
      </form>
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
        timeoutMs: ESPERA_MT5_MS,
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
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!guardando) void guardar(); }}>
        <Field label="Fecha de conexión" required>
          <Input type="date" value={fecha} max={hoy} onChange={(e) => setFecha(e.target.value)} />
        </Field>

        {cambioFecha && (
          <Notice kind="pend" title="Se va a recalcular el PnL mes a mes">
            El PnL guardado se borra y se vuelve a pedir a MT5 con la fecha nueva. Puede tardar
            unos segundos. Si MT5 no responde, la fecha <strong>no</strong> se cambia y queda
            todo como está.
          </Notice>
        )}

        <Field
          label="Equity MT5 a la fecha de conexión"
          hint={cuenta.connection_values_manual
            ? 'Cargado a mano. Vaciá el campo para que vuelva a calcularse solo desde MT5.'
            : 'Se reconstruye desde MT5 restándole al saldo de hoy todo lo que se movió después. Escribilo sólo si tenés el número real y el calculado no sirve.'}
        >
          <Input
            type="text"
            inputMode="decimal"
            className="tabular-nums"
            value={equity}
            onChange={(e) => setEquity(e.target.value)}
            placeholder="Se calcula solo desde MT5"
          />
        </Field>

        {/* Sólo cuando el calculado es una aproximación. Decirlo siempre
            enseñaría a ignorar el aviso. */}
        {connectionEquityTag(cuenta) === 'approx' && (
          <Notice kind="pend" title={`Había ${cuenta.connection_open_positions} posición(es) abierta(s) ese día`}>
            El número de arriba es el <strong>balance</strong>. El equity incluía además el
            flotante de esas posiciones, y MT5 no guarda el precio de ese momento — no se puede
            reconstruir. Si tenés el equity real del reporte, escribilo acá.
          </Notice>
        )}

        <Field
          label="Equity a Liquidez"
          hint={cuenta.liquidez_manual
            ? 'Cargado a mano. Vaciá el campo para volver a lo que calculó el análisis de duplicados.'
            : 'Cuánto aporta esta cuenta al pool. Sale del análisis de duplicados: si el cliente movió plata entre cuentas propias, se cuenta una sola vez. Editalo si sabés el monto real que se envió.'}
        >
          <Input
            type="text"
            inputMode="decimal"
            className="tabular-nums"
            value={liquidez}
            onChange={(e) => setLiquidez(e.target.value)}
            placeholder="Lo decide el análisis de duplicados"
          />
        </Field>

        <Field label="Nota" error={err ?? undefined}>
          <Textarea value={nota} onChange={(e) => setNota(e.target.value)} rows={4} />
        </Field>
        <div className="flex justify-end gap-2">
          <ActionButton onClick={onClose}>Cancelar</ActionButton>
          <ActionButton type="submit" variant="primary" loading={guardando}>
            {guardando ? (cambioFecha ? 'Recalculando PnL…' : 'Guardando…') : 'Guardar'}
          </ActionButton>
        </div>
      </form>
    </Modal>
  );
}

function ModalDetalle({ cuenta, onClose }: { cuenta: Cuenta; onClose: () => void }) {
  const [meses, setMeses] = useState<MesPnl[] | null>(null);
  // `null` hasta que llega: el total de un historial que no se cargó no es 0.
  const [total, setTotal] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiFetch(`/api/superadmin/liquidity/accounts/${cuenta.id}/monthly-pnl`);
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
        setMeses(json.months);
        setTotal(toAmount(json.total));
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Error cargando el PnL');
        setMeses([]);
      }
    })();
  }, [cuenta.id]);

  const tag = connectionEquityTag(cuenta);
  const columnas: FinColumn<MesPnl>[] = [
    {
      key: 'mes',
      header: 'Mes',
      cell: (m) => <span className={NUM_CLASS}>{mesLabel(m.year, m.month)}</span>,
      meta: (m) => (m.is_partial ? 'parcial' : undefined),
    },
    { key: 'pnl', header: 'PnL', kind: 'money', value: (m) => toAmount(m.pnl), money: { signed: true, tone: 'sign' } },
    { key: 'ops', header: 'Operaciones', kind: 'number', value: (m) => m.operations_count, subtotal: false },
  ];

  return (
    <Modal title={`Cuenta ${cuenta.mt5_account}`} onClose={onClose}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Campo label="Usuario">{cuenta.mt5_email ?? '—'}</Campo>
        <Campo label="Grupo">{cuenta.mt5_group ?? '—'}</Campo>
        <Campo label="Status"><StatusBadge kind={poolStatusKind(cuenta.status)} label={ESTADO[cuenta.status] ?? cuenta.status} /></Campo>
        <Campo label="Balance MT5"><Money value={toAmount(cuenta.balance)} /></Campo>
        <Campo label="Equity a Liquidez"><Money value={toAmount(cuenta.balance_liquidez)} /></Campo>
        <Campo label="Equity a la conexión">
          <Money value={toAmount(cuenta.equity_at_connection)} />
          {tag && <span className={cn('ml-1 text-[12px] font-normal', tag === 'approx' ? 'text-pend' : 'text-text-3')}>({tag === 'manual' ? 'manual' : 'aprox.'})</span>}
        </Campo>
        <Campo label="Equity"><Money value={toAmount(cuenta.equity)} /></Campo>
        <Campo label="Conectada"><span className={NUM_CLASS}>{formatFechaConexion(cuenta.connection_date)}</span></Campo>
        <Campo label="Actualizada"><span className={NUM_CLASS}>{cuenta.last_synced_at ? formatDateTime(cuenta.last_synced_at) : '—'}</span></Campo>
      </dl>

      <div className="mt-4 space-y-2">
        {differsFromMt5(cuenta) && (
          <Notice kind="info" title="El aporte al pool difiere del balance de MT5">
            Parte de este dinero ya estaba contado en otra cuenta del mismo cliente.
          </Notice>
        )}
        {cuenta.has_multiple_accounts_warning && (
          <Notice kind="pend" title="El cliente tiene otra(s) cuenta(s) en el pool">
            No se detectó transferencia entre ellas. Verificar que el dinero no esté contado dos veces.
          </Notice>
        )}
        {cuenta.sync_error && (
          <Notice kind="bad" title="Error de sincronización">{cuenta.sync_error}</Notice>
        )}
        {cuenta.deactivated_reason && (
          <p className="text-[12.5px] text-text-2">Desactivada: {cuenta.deactivated_reason}</p>
        )}
        {cuenta.note && <p className="text-[12.5px] text-text-2">Nota: {cuenta.note}</p>}
      </div>

      <h3 className="mt-5 text-[13px] font-semibold">Historial de PnL mensual</h3>
      {err && <Notice kind="bad" title="No se pudo cargar el PnL" className="mt-2">{err}</Notice>}
      {meses === null ? (
        <Skeleton className="mt-2 h-24" />
      ) : (
        <div className="mt-2 overflow-hidden rounded-ui-md border border-border">
          <FinTable
            caption="Historial de PnL mensual"
            columns={columnas}
            rows={meses}
            rowKey={(m) => `${m.year}-${m.month}`}
            empty="Sin PnL calculado todavía."
            footer={meses.length > 0 ? { label: 'Total', values: { pnl: total } } : undefined}
          />
        </div>
      )}
    </Modal>
  );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium text-text-2">{label}</dt>
      <dd className="truncate text-[13px] font-medium text-foreground">{children}</dd>
    </div>
  );
}
