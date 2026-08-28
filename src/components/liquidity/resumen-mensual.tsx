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
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { formatCurrency } from '@/lib/utils';
import { formatFechaConexion } from '@/lib/liquidity/connection-date';
import { MESES, mesLabel, Stat } from './ui';

interface MesResumen {
  year: number;
  month: number;
  total: number;
  operations: number;
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
  is_partial: boolean;
}

export function ResumenMensual({ companyId }: { companyId: string }) {
  const [meses, setMeses] = useState<MesResumen[] | null>(null);
  const [totales, setTotales] = useState<{ pnl: number; ops: number }>({ pnl: 0, ops: 0 });
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
        setTotales({ pnl: json.grand_total ?? 0, ops: json.grand_operations ?? 0 });
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
  }, [companyId]);

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
    return <div className="rounded-lg bg-negative/10 text-negative p-3 text-sm">{err}</div>;
  }

  if (meses === null) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-9 w-80 rounded-lg bg-muted/50" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-20 rounded-xl bg-muted/50" />)}
        </div>
      </div>
    );
  }

  if (meses.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        Todavía no hay PnL calculado. Agregá una cuenta al pool y el resumen mensual aparece solo.
      </div>
    );
  }

  const tono = (n: number) => (n < 0 ? 'negative' as const : n > 0 ? 'positive' as const : 'muted' as const);

  return (
    <div className="space-y-6">
      {/* Año + los 12 meses */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={anio ?? ''}
          onChange={(e) => cambiarAnio(Number(e.target.value))}
          className="h-9 px-2 rounded-lg border border-border bg-card text-sm font-medium"
        >
          {anios.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>

        <div className="flex flex-wrap gap-1">
          {MESES.map((etiqueta, i) => {
            const m = i + 1;
            const dato = delAnio.get(m);
            const activo = sel?.year === anio && sel?.month === m;
            return (
              <button
                key={m}
                disabled={!dato}
                onClick={() => anio && setSel({ year: anio, month: m })}
                title={dato ? undefined : 'Sin datos en este mes'}
                className={`h-9 px-3 rounded-lg text-sm font-medium transition-colors ${
                  activo
                    ? 'bg-[var(--color-primary)] text-white'
                    : dato
                      ? 'border border-border bg-card hover:bg-muted'
                      : 'border border-dashed border-border text-muted-foreground/40 cursor-not-allowed'
                }`}
              >
                {etiqueta}
              </button>
            );
          })}
        </div>
      </div>

      {/* Totales del mes elegido */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat
          label={sel ? `PnL de ${mesLabel(sel.year, sel.month)}` : 'PnL del mes'}
          value={formatCurrency(mesActual?.total ?? 0)}
          tone={tono(mesActual?.total ?? 0)}
          sub={mesActual?.is_partial ? 'Mes parcial' : undefined}
        />
        <Stat label="Operaciones" value={String(mesActual?.operations ?? 0)} />
        <Stat
          label="Cuentas en el pool"
          value={String(mesActual?.accounts ?? 0)}
          // "Estaban" y "operaron" son datos distintos: sin el segundo, un mes
          // tranquilo se lee como un mes sin cuentas.
          sub={`${mesActual?.accounts_with_activity ?? 0} con operaciones`}
        />
        <Stat
          label="Acumulado del pool"
          value={formatCurrency(totales.pnl)}
          sub={`${totales.ops} operaciones en total`}
          tone={tono(totales.pnl)}
        />
      </div>

      {/* Detalle por cuenta */}
      <div className="rounded-xl border border-border bg-card overflow-x-auto">
        {filas === null ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Cargando el mes…</div>
        ) : filas.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            Ninguna cuenta estaba en el pool en {sel ? mesLabel(sel.year, sel.month) : 'ese mes'}.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2 px-3 text-left font-medium">Cuenta</th>
                <th className="py-2 px-3 text-left font-medium">Usuario</th>
                <th className="py-2 px-3 text-right font-medium">PnL del mes</th>
                <th className="py-2 px-3 text-right font-medium">Ops</th>
                <th className="py-2 px-3 text-right font-medium">Equity a Liquidez</th>
                <th className="py-2 px-3 text-left font-medium">Conectada</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f) => (
                <tr key={f.account_id} className="border-t border-border">
                  <td className="py-2 px-3 font-medium">{f.mt5_account}</td>
                  <td className="py-2 px-3 text-muted-foreground">{f.mt5_email ?? '—'}</td>
                  <td className={`py-2 px-3 text-right font-semibold ${
                    f.pnl < 0 ? 'text-negative' : f.pnl > 0 ? 'text-positive' : 'text-muted-foreground'
                  }`}>
                    {formatCurrency(f.pnl)}
                    {f.is_partial && (
                      <span className="ml-1 text-[10px] font-normal text-muted-foreground">parcial</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right text-muted-foreground">{f.operations_count}</td>
                  <td className="py-2 px-3 text-right">{formatCurrency(f.balance_liquidez)}</td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {formatFechaConexion(f.connection_date)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                <td className="py-2 px-3" colSpan={2}>Total del mes</td>
                <td className={`py-2 px-3 text-right ${
                  (mesActual?.total ?? 0) < 0 ? 'text-negative'
                    : (mesActual?.total ?? 0) > 0 ? 'text-positive' : ''
                }`}>
                  {formatCurrency(mesActual?.total ?? 0)}
                </td>
                <td className="py-2 px-3 text-right">{mesActual?.operations ?? 0}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}
