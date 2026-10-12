'use client';

// ─────────────────────────────────────────────────────────────────────────────
// Resumen mensual del pool: cuánto rindió cada mes y qué aportó cada cuenta.
//
// ── POR QUÉ EL SELECTOR NO ES EL `PeriodSelector` DEL REPO ─────────────────
// Aquél lo alimentan los períodos CONTABLES de la empresa, que son otra cosa:
// acá los meses salen del PnL de MT5. Un mes contable puede no tener ninguna
// operación, y un mes con operaciones puede no tener período abierto. Los meses
// que se ofrecen son los que TIENEN datos; los demás se dibujan apagados, para
// que se vea que el año existe y ese mes no tuvo pool.
//
// ── LA COLUMNA "CONECTADA" NO ES DECORACIÓN ────────────────────────────────
// Explica por qué una cuenta no aparece en los meses anteriores. Sin ella, una
// cuenta que entró en junio se lee como si hubiera rendido cero en mayo, y no
// es lo mismo: en mayo no estaba.
//
// ── «LIBRO MAYOR» (2026-10-12) ─────────────────────────────────────────────
// Sólo presentación. Las cuatro `Stat` → una franja de KPIs (PnL del mes
// hero con color por signo); los 12 meses son `Chip` (los vacíos, apagados);
// la tabla es una FinTable con el «parcial» como metadato del PnL y el total
// del MES (el del resumen, no la suma de lo visible) en el pie.
// Antes, sin mes elegido, los KPIs decían «$0.00» / «0» (`?? 0`): ahora «—».
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { cn } from '@/lib/utils';
import { formatFechaConexion } from '@/lib/liquidity/connection-date';
import { Panel } from '@/components/ui/panel';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { NUM_CLASS } from '@/components/ui/money';
import { Notice } from '@/components/ui/notice';
import { Chip } from '@/components/ui/chip';
import { Select } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { MESES, mesLabel } from './ui';
import { toAmount } from './pool-view-model';

interface MesResumen {
  year: number;
  month: number;
  total: number;
  operations: number;
  /** Lotes cerrados en el mes. */
  lots: number;
  /** Cuántas cuentas ESTABAN en el pool ese mes. */
  accounts: number;
  /** De ésas, cuántas operaron. */
  accounts_with_activity: number;
  is_partial: boolean;
}

interface FilaMes {
  account_id: string;
  mt5_account: string;
  mt5_email: string | null;
  balance_liquidez: number;
  connection_date: string;
  pnl: number;
  operations_count: number;
  /** `null` = calculado antes de la migracion 116, no es cero lotes. */
  lots: number | null;
  is_partial: boolean;
}

/**
 * Si el mes que se está mirando es el de conexión de esa cuenta.
 *
 * Distingue los dos motivos por los que una fila sale «parcial»: entró a mitad
 * de mes, o el mes no terminó. Se compara en UTC porque la fecha de conexión se
 * guarda anclada a las 00:00 UTC.
 */
function esMesDeConexion(
  f: { connection_date: string },
  sel: { year: number; month: number } | null,
): boolean {
  if (!sel) return false;
  const d = new Date(f.connection_date);
  if (Number.isNaN(d.getTime())) return false;
  return d.getUTCFullYear() === sel.year && d.getUTCMonth() + 1 === sel.month;
}

export function ResumenMensual({ companyId, refrescoNonce = 0 }: { companyId: string; refrescoNonce?: number }) {
  const [meses, setMeses] = useState<MesResumen[] | null>(null);
  // `null` = el endpoint no lo mandó: «—», no $0.00.
  const [totales, setTotales] = useState<{ pnl: number | null; ops: number | null }>({ pnl: null, ops: null });
  const [sel, setSel] = useState<{ year: number; month: number } | null>(null);
  const [anio, setAnio] = useState<number | null>(null);
  const [filas, setFilas] = useState<FilaMes[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // La lista de meses, una vez por empresa.
  useEffect(() => {
    let vivo = true;
    setMeses(null); setFilas(null); setSel(null); setAnio(null); setErr(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/superadmin/liquidity/monthly-summary?company_id=${companyId}`);
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
        if (!vivo) return;
        const lista: MesResumen[] = json.months ?? [];
        setMeses(lista);
        setTotales({ pnl: toAmount(json.grand_total), ops: toAmount(json.grand_operations) });
        // Arranca en el más reciente, que es el que se mira.
        if (lista.length > 0) {
          setSel({ year: lista[0].year, month: lista[0].month });
          setAnio(lista[0].year);
        }
      } catch (e) {
        if (!vivo) return;
        setErr(e instanceof Error ? e.message : 'Error cargando los meses');
        setMeses([]);
      }
    })();
    return () => { vivo = false; };
  }, [companyId, refrescoNonce]);

  // El detalle del mes elegido.
  useEffect(() => {
    if (!sel) return;
    let vivo = true;
    setFilas(null);
    (async () => {
      try {
        const res = await apiFetch(
          `/api/superadmin/liquidity/monthly-summary?company_id=${companyId}&year=${sel.year}&month=${sel.month}`,
        );
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
        if (!vivo) return;
        setFilas(json.rows ?? []);
      } catch (e) {
        if (!vivo) return;
        setErr(e instanceof Error ? e.message : 'Error cargando el mes');
        setFilas([]);
      }
    })();
    return () => { vivo = false; };
  }, [companyId, sel]);

  const anios = useMemo(
    () => [...new Set((meses ?? []).map((m) => m.year))].sort((a, b) => b - a),
    [meses],
  );

  const mesActual = useMemo(
    () => (meses ?? []).find((m) => sel && m.year === sel.year && m.month === sel.month) ?? null,
    [meses, sel],
  );

  // Indexados por número de mes para poder dibujar los 12 y apagar los vacíos.
  const delAnio = useMemo(() => {
    const map = new Map<number, MesResumen>();
    for (const m of meses ?? []) if (m.year === anio) map.set(m.month, m);
    return map;
  }, [meses, anio]);

  function cambiarAnio(y: number) {
    setAnio(y);
    // Salta al mes más reciente CON datos de ese año. Dejar seleccionado uno
    // vacío mostraría una tabla en cero que parece un error de cálculo.
    const delNuevo = (meses ?? []).filter((m) => m.year === y);
    if (delNuevo.length > 0) setSel({ year: y, month: delNuevo[0].month });
  }

  if (err) {
    return <Notice kind="bad" title="No se pudo cargar el resumen mensual">{err}</Notice>;
  }

  if (meses === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-[92px]" />
      </div>
    );
  }

  if (meses.length === 0) {
    return (
      <Panel>
        <p className="py-4 text-center text-[13px] text-text-3">
          Todavía no hay PnL calculado. Agregá una cuenta al pool y el resumen mensual aparece solo.
        </p>
      </Panel>
    );
  }

  // El total ya NO se marca con `is_partial`.
  //
  // Esa bandera es `true` si CUALQUIER fila del mes lo es, y una fila lo es por
  // dos motivos distintos: el mes no terminó, o esa cuenta entró a mitad de mes.
  // Junio 2026 salía como «Mes parcial» estando terminado, sólo porque 3 de 29
  // cuentas se conectaron el 10 y el 12 — daba a entender que faltaban datos del
  // mes cuando el total estaba completo.
  //
  // Lo que sí vale decir del TOTAL es si el mes sigue corriendo, y eso se sabe
  // por el calendario, sin preguntarle a las filas. El aviso por cuenta se
  // queda donde significa algo: en la fila.
  const ahora = new Date();
  const esteAnio = ahora.getUTCFullYear();
  const esteMes = ahora.getUTCMonth() + 1;
  const mesEnCurso = sel !== null && sel.year === esteAnio && sel.month === esteMes;
  const etiquetaMes = sel ? mesLabel(sel.year, sel.month) : 'ese mes';

  // `mesActual` es null sólo si el mes elegido no está en la lista: «—», no 0.
  const kpis: KpiItem[] = [
    {
      key: 'pnl',
      label: sel ? `PnL de ${etiquetaMes}` : 'PnL del mes',
      value: mesActual?.total ?? null,
      hero: true,
      // 'money' y no el compact por defecto (dueño, 2026-10-12): "-$1.2K"
      // omite dato en una cifra que acá se lee para decidir — el valor exacto
      // no puede vivir solo en el title.
      format: 'money',
      tone: 'sign',
      sub: mesEnCurso ? 'Mes en curso' : undefined,
    },
    {
      key: 'ops',
      label: 'Operaciones',
      value: mesActual?.operations ?? null,
      format: 'count',
      // El volumen dice cuánto TRABAJO hizo el pool para llegar a ese
      // resultado: dos meses con el mismo PnL no son lo mismo si uno movió
      // 2 lotes y el otro 400.
      sub: mesActual ? `${fmtLotes(mesActual.lots)} lotes` : undefined,
    },
    {
      key: 'accounts',
      label: 'Cuentas en el pool',
      value: mesActual?.accounts ?? null,
      format: 'count',
      // "Estaban" y "operaron" son datos distintos: sin el segundo, un mes
      // tranquilo se lee como un mes sin cuentas.
      sub: mesActual ? `${mesActual.accounts_with_activity} con operaciones` : undefined,
    },
    {
      key: 'acc',
      label: 'Acumulado del pool',
      value: totales.pnl,
      format: 'money', // exacto, no "-$46.6K" (ver el KPI de PnL)
      tone: 'sign',
      sub: totales.ops === null ? undefined : `${totales.ops} operaciones en total`,
    },
  ];

  const columnas: FinColumn<FilaMes>[] = [
    {
      key: 'cuenta',
      header: 'Cuenta',
      cell: (f) => <span className={NUM_CLASS}>{f.mt5_account}</span>,
      meta: (f) => f.mt5_email ?? undefined,
      mobileMeta: (f) => <span className={NUM_CLASS}>Conectada {formatFechaConexion(f.connection_date)}</span>,
    },
    {
      key: 'pnl',
      header: 'PnL del mes',
      kind: 'money',
      value: (f) => toAmount(f.pnl),
      money: { signed: true, tone: 'sign' },
      // «Parcial» tiene dos motivos y el tooltip dice cuál, que es la pregunta
      // que la palabra sola dejaba abierta.
      meta: (f) => (f.is_partial ? (
        <span
          title={
            esMesDeConexion(f, sel)
              ? `Entró al pool el ${formatFechaConexion(f.connection_date)}: el PnL cuenta `
                + 'desde esa fecha, no desde el 1. Si operó antes, eso no está acá.'
              : 'El mes todavía no terminó.'
          }
        >
          parcial
        </span>
      ) : undefined),
      subtotal: false,
    },
    { key: 'ops', header: 'Ops', kind: 'number', value: (f) => f.operations_count, hideSm: true, subtotal: false },
    {
      // `null` es «se calculó antes de que existiera esta columna», no «operó
      // cero lotes». Por eso va un guion y no un 0 — se arregla refrescando.
      key: 'lotes',
      header: 'Lotes',
      align: 'right',
      hideSm: true,
      cell: (f) => (f.lots === null || f.lots === undefined
        ? <span className="text-text-3" title="Sin calcular: refrescá la cuenta">—</span>
        : <span className={NUM_CLASS}>{fmtLotes(f.lots)}</span>),
    },
    { key: 'liquidez', header: 'Equity a Liquidez', kind: 'money', value: (f) => toAmount(f.balance_liquidez), hideSm: true, subtotal: false },
    {
      key: 'conectada',
      header: 'Conectada',
      hideSm: true,
      cell: (f) => <span className={cn(NUM_CLASS, 'text-text-2')}>{formatFechaConexion(f.connection_date)}</span>,
    },
  ];

  return (
    <div className="space-y-4">
      {/* Año + los 12 meses */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Año"
          value={anio ?? ''}
          onChange={(e) => cambiarAnio(Number(e.target.value))}
          className="h-8 w-auto [@media(pointer:coarse)]:h-10"
        >
          {anios.map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>

        {MESES.map((etiqueta, i) => {
          const m = i + 1;
          const dato = delAnio.get(m);
          return (
            <Chip
              key={m}
              active={sel?.year === anio && sel?.month === m}
              disabled={!dato}
              onClick={() => anio && setSel({ year: anio, month: m })}
              title={dato ? undefined : 'Sin datos en este mes'}
            >
              {etiqueta}
            </Chip>
          );
        })}
      </div>

      {/* El mes EN CURSO sin datos no está «bloqueado»: nadie lo generó aún.
          Este módulo carga a demanda por pedido del dueño (agosto 2026:
          botón en vez de carga automática), así que hasta el primer
          «Refrescar todo» del mes el botón sale apagado y parecía un bug
          (dueño, 2026-09-28: «sep no me deja abrirlo, está bloqueado»).
          El aviso lo dice en el momento, sin depender de un tooltip que un
          botón disabled no siempre dispara. Corte de mes en UTC, como todo
          el sistema. */}
      {anio === esteAnio && !delAnio.has(esteMes) && (
        <Notice kind="stale" title={`${MESES[esteMes - 1]} aún no tiene datos`}>
          Tocá «Refrescar todo» (arriba) para calcular el mes en curso.
        </Notice>
      )}

      {/* Totales del mes elegido */}
      <KpiStrip items={kpis} />

      {/* Detalle por cuenta */}
      <Panel title={`Detalle por cuenta · ${etiquetaMes}`} flush>
        {filas === null ? (
          <div className="p-4"><Skeleton className="h-40" /></div>
        ) : (
          <FinTable
            caption={`Detalle por cuenta, ${etiquetaMes}`}
            columns={columnas}
            rows={filas}
            rowKey={(f) => f.account_id}
            empty={`Ninguna cuenta estaba en el pool en ${etiquetaMes}.`}
            footer={
              filas.length > 0
                ? {
                    // El total es el del mes (del resumen), no la suma de lo
                    // visible: si difieren, el número de arriba manda y el de
                    // acá es el mismo.
                    label: mesActual
                      ? `Total del mes · ${mesActual.operations} ops · ${fmtLotes(mesActual.lots)} lotes`
                      : 'Total del mes',
                    values: { pnl: mesActual?.total ?? null },
                  }
                : undefined
            }
          />
        )}
      </Panel>
    </div>
  );
}

/** Lotes con hasta 2 decimales. No es dinero: no pasa por `formatMoney`. */
function fmtLotes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('es', { maximumFractionDigits: 2 });
}
