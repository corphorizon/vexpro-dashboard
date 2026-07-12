'use client';

/**
 * /finanzas/consolidado — Tabla mes a mes con todos los indicadores
 * financieros del tenant, columnas ocultables, filas (meses) ocultables,
 * y total acumulado al pie. Pensada para el usuario ejecutivo que quiere
 * ver una sola foto de toda la operación sin saltar entre páginas.
 *
 * Feature pedida por Kevin (2026-06-06):
 *   "quiero una tabla con depositos, retiros, net deposit, Broker P&L,
 *   Balance Prop Firm, Profits inversión, egresos operativos, reserva,
 *   reserva acumulada, monto a distribuir … que abajo sume todo, me lo
 *   discrimine por mes y que yo pueda ocultar columnas si lo necesito"
 *
 * Implementación
 *   - Lee TODO el rango de períodos del DataProvider (no requiere RPC
 *     nuevo; los hooks ya existen y la performance es razonable para
 *     ≤24 meses, que es el horizonte realista).
 *   - Cálculo por columna replicado de los mismos helpers que
 *     /resumen-general y /socios usan, así nada queda inconsistente.
 *   - Estado de columnas/meses ocultos persistido en localStorage para
 *     que el usuario lo recupere entre sesiones.
 *   - Export a CSV respetando las columnas/meses visibles — útil para
 *     compartir con contabilidad.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { useData } from '@/lib/data-context';
import { useAuth } from '@/lib/auth-context';
import { hasModuleAccess } from '@/lib/auth-context';
import { formatCurrency } from '@/lib/utils';
import { downloadCSV } from '@/lib/csv-export';
import { withActiveCompany } from '@/lib/api-fetch';
import {
  Table,
  Download,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';

// Column definition. `compute` recibe los helpers del DataProvider + el
// período y devuelve un número. `kind` permite reutilizar formato/clase
// (positivo = verde, negativo = rojo, neutro). `total` define cómo se
// agrega en el pie de tabla — la mayoría es suma directa, algunos campos
// (reserva acumulada) son el último valor visible.
interface PeriodRowContext {
  periodId: string;
  periodLabel: string;
  // datos pre-calculados para evitar repetir el getPeriodSummary
  summary: ReturnType<ReturnType<typeof useData>['getPeriodSummary']>;
  saldoInfo: { reservaPeriodo: number; reservaAcumulada: number; montoDistribuir: number } | null;
  // API totales del mes (Coinsbuy + FairPay + UniPayment). Llenado desde
  // /api/integrations/period-totals que ya respeta pinned_coinsbuy_wallets.
  // Sumado a `summary.totalDeposits` (manual) para mostrar el monto real.
  // Antes la tabla solo leía manuales y Mayo/Junio aparecían como $0.
  apiDeposits: number;
  apiWithdrawals: number;
}

interface ColumnDef {
  key: string;
  label: string;
  compute: (ctx: PeriodRowContext) => number;
  total: 'sum' | 'last' | 'none';
  kind: 'pos' | 'neg' | 'neutral';
}

const STORAGE_HIDDEN_COLS = 'fd_consolidado_hidden_cols';
const STORAGE_HIDDEN_MONTHS = 'fd_consolidado_hidden_months';

function loadSet(key: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? new Set(arr.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function saveSet(key: string, set: Set<string>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(Array.from(set)));
  } catch {
    /* quota o disabled */
  }
}

export default function ConsolidadoPage() {
  const {
    company,
    periods,
    getPeriodSummary,
    computeSaldoChain,
    isPeriodAfterSaldoStart,
  } = useData();
  const { user } = useAuth();

  // Module gate: aprovecha el de "reports" porque la página vive bajo
  // /finanzas (mismo cluster ejecutivo). Si la empresa no tiene reports
  // habilitado, redirigimos al inicio.
  const canAccess = hasModuleAccess(user, 'reports', company?.active_modules ?? null);

  const [hiddenCols, setHiddenColsState] = useState<Set<string>>(() => loadSet(STORAGE_HIDDEN_COLS));
  const [hiddenMonths, setHiddenMonthsState] = useState<Set<string>>(() => loadSet(STORAGE_HIDDEN_MONTHS));
  const [showSettings, setShowSettings] = useState(false);

  // Persist toggles
  useEffect(() => saveSet(STORAGE_HIDDEN_COLS, hiddenCols), [hiddenCols]);
  useEffect(() => saveSet(STORAGE_HIDDEN_MONTHS, hiddenMonths), [hiddenMonths]);

  const toggleCol = (key: string) => {
    setHiddenColsState((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleMonth = (id: string) => {
    setHiddenMonthsState((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ─── Cálculos ──────────────────────────────────────────────────────────
  //
  // Reusamos computeSaldoChain (la misma que /resumen-general y /socios)
  // para que reserva/reserva acumulada/monto a distribuir queden alineados.
  // Los demás campos se derivan de getPeriodSummary del DataProvider.

  const saldoChain = useMemo(() => computeSaldoChain(), [computeSaldoChain]);

  // ─── API totales por período ─────────────────────────────────────────────
  //
  // /api/integrations/period-totals devuelve un objeto
  // `months: { '2026-04': { deposits, withdrawals } }` aplicando el filtrado
  // por pinned_coinsbuy_wallets que ya teníamos. Lo cargamos una sola vez
  // (al cambiar de empresa) y lo guardamos en estado para que cada fila
  // de la tabla sume API + manual.
  const [apiMonths, setApiMonths] = useState<
    Record<string, { deposits: number; withdrawals: number }>
  >({});

  useEffect(() => {
    if (!company || periods.length === 0) return;
    const sorted = [...periods].sort((a, b) =>
      a.year !== b.year ? a.year - b.year : a.month - b.month,
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const pad = (n: number) => String(n).padStart(2, '0');
    const lastDay = new Date(last.year, last.month, 0).getDate();
    const from = `${first.year}-${pad(first.month)}-01`;
    const to = `${last.year}-${pad(last.month)}-${pad(lastDay)}`;
    const controller = new AbortController();
    (async () => {
      try {
        // withActiveCompany: cuando un superadmin entra viewing-as un
        // tenant, el endpoint verifyAuth() leería el cookie session
        // (superadmin) y devolvería los datos de su company, NO los
        // del tenant que está viewing. withActiveCompany inyecta el
        // header X-Active-Company que el server respeta — mismo patrón
        // que MonthlyChart en /resumen-general ya usaba.
        const url = withActiveCompany(
          `/api/integrations/period-totals?from=${from}&to=${to}`,
        );
        const res = await fetch(url, { signal: controller.signal });
        const json = await res.json();
        if (json?.success && json.months) {
          setApiMonths(json.months);
        }
      } catch {
        // Silent — fallback es 0 y aún se ven los datos manuales.
      }
    })();
    return () => controller.abort();
  }, [company, periods]);

  const periodContexts: PeriodRowContext[] = useMemo(() => {
    return periods.map((p) => {
      const summary = getPeriodSummary(p.id);
      const saldoEntry = saldoChain.get(p.id);
      // Campos canónicos de la fórmula única de distribución (BUG-01). Antes
      // se derivaban de forma retorcida del modelo viejo (saldoNuevo/Anterior/
      // Usado); ahora se leen directo de la cadena canónica.
      const saldoInfo = saldoEntry
        ? {
            reservaPeriodo: saldoEntry.reserveThisPeriod,
            reservaAcumulada: saldoEntry.reserveAccumulated,
            montoDistribuir: saldoEntry.montoDistribuir,
          }
        : null;
      const key = `${p.year}-${String(p.month).padStart(2, '0')}`;
      const api = apiMonths[key] ?? { deposits: 0, withdrawals: 0 };
      return {
        periodId: p.id,
        periodLabel: p.label ?? key,
        summary,
        saldoInfo,
        apiDeposits: api.deposits,
        apiWithdrawals: api.withdrawals,
      };
    });
  }, [periods, getPeriodSummary, saldoChain, apiMonths]);

  // Definición de columnas. Orden = orden de aparición en la tabla.
  const columns: ColumnDef[] = useMemo(
    () => [
      {
        key: 'totalDeposits',
        label: 'Depósitos',
        // API (Coinsbuy + FairPay + UniPayment) + manual. Antes solo
        // se mostraba el manual (`summary.totalDeposits`) y los meses
        // sin entrada manual aparecían como $0 aunque la API tuviera
        // cientos de miles. Coincide con la fórmula de /movimientos.
        compute: (c) => c.apiDeposits + (c.summary?.totalDeposits ?? 0),
        total: 'sum',
        kind: 'pos',
      },
      {
        key: 'totalWithdrawals',
        label: 'Retiros',
        // API + manual (broker como Coinsbuy supplement). Misma lógica
        // que el card "Retiros Totales" en /movimientos.
        compute: (c) => {
          const manualBroker =
            c.summary?.withdrawals?.find((w) => w.category === 'broker')?.amount ?? 0;
          return c.apiWithdrawals + manualBroker;
        },
        total: 'sum',
        kind: 'neg',
      },
      {
        key: 'netDeposit',
        label: 'Net Deposit',
        compute: (c) => {
          const deposits = c.apiDeposits + (c.summary?.totalDeposits ?? 0);
          const manualBroker =
            c.summary?.withdrawals?.find((w) => w.category === 'broker')?.amount ?? 0;
          const withdrawals = c.apiWithdrawals + manualBroker;
          return deposits - withdrawals;
        },
        total: 'sum',
        kind: 'neutral',
      },
      {
        key: 'brokerPnl',
        label: 'Broker P&L',
        compute: (c) => c.summary?.operatingIncome?.broker_pnl ?? 0,
        total: 'sum',
        kind: 'neutral',
      },
      {
        key: 'propFirmNet',
        label: 'Balance Prop Firm',
        compute: (c) => c.summary?.propFirmNetIncome ?? 0,
        total: 'sum',
        kind: 'neutral',
      },
      {
        key: 'investmentProfits',
        label: 'Profits Inversión',
        compute: (c) => c.summary?.investmentProfits ?? 0,
        total: 'sum',
        kind: 'neutral',
      },
      {
        key: 'operatingExpenses',
        label: 'Egresos Operativos',
        compute: (c) => c.summary?.totalExpenses ?? 0,
        total: 'sum',
        kind: 'neg',
      },
      {
        key: 'reservaPeriodo',
        label: 'Reserva del Período',
        compute: (c) => {
          if (!c.summary) return 0;
          if (!isPeriodAfterSaldoStart(c.periodId)) return 0;
          // 10% del total a distribuir (calculado igual que la página /socios)
          const md = c.saldoInfo?.montoDistribuir ?? 0;
          const pct = 0.10;
          return md * pct;
        },
        total: 'sum',
        kind: 'neutral',
      },
      {
        key: 'reservaAcumulada',
        label: 'Reserva Acumulada',
        compute: (c) => c.saldoInfo?.reservaAcumulada ?? 0,
        total: 'last',
        kind: 'neutral',
      },
      {
        key: 'montoDistribuir',
        label: 'Monto a Distribuir',
        compute: (c) => (c.saldoInfo?.montoDistribuir ?? 0) * 0.9,
        total: 'sum',
        kind: 'pos',
      },
      {
        key: 'p2p',
        label: 'Transferencia P2P',
        compute: (c) => c.summary?.p2pTransfer ?? 0,
        total: 'sum',
        kind: 'neutral',
      },
      {
        key: 'propFirmSales',
        label: 'Ventas Prop Firm',
        compute: (c) => c.summary?.propFirmSales ?? 0,
        total: 'sum',
        kind: 'pos',
      },
      {
        key: 'expensesPaid',
        label: 'Egresos Pagados',
        compute: (c) => c.summary?.totalExpensesPaid ?? 0,
        total: 'sum',
        kind: 'neutral',
      },
      {
        key: 'expensesPending',
        label: 'Egresos Pendientes',
        compute: (c) => c.summary?.totalExpensesPending ?? 0,
        total: 'sum',
        kind: 'neg',
      },
    ],
    [isPeriodAfterSaldoStart],
  );

  const visibleColumns = useMemo(
    () => columns.filter((c) => !hiddenCols.has(c.key)),
    [columns, hiddenCols],
  );
  const visiblePeriodContexts = useMemo(
    () => periodContexts.filter((c) => !hiddenMonths.has(c.periodId)),
    [periodContexts, hiddenMonths],
  );

  // Totals row per visible column (con regla de agregación).
  const totals = useMemo(() => {
    const result = new Map<string, number>();
    for (const col of visibleColumns) {
      if (col.total === 'none') continue;
      if (col.total === 'sum') {
        const sum = visiblePeriodContexts.reduce(
          (acc, ctx) => acc + col.compute(ctx),
          0,
        );
        result.set(col.key, sum);
      } else if (col.total === 'last') {
        const last = visiblePeriodContexts[visiblePeriodContexts.length - 1];
        result.set(col.key, last ? col.compute(last) : 0);
      }
    }
    return result;
  }, [visibleColumns, visiblePeriodContexts]);

  const handleExportCsv = () => {
    const headers = ['Mes', ...visibleColumns.map((c) => c.label)];
    const rows = visiblePeriodContexts.map((ctx) => [
      ctx.periodLabel,
      ...visibleColumns.map((c) => c.compute(ctx).toFixed(2)),
    ]);
    rows.push([
      'TOTAL',
      ...visibleColumns.map((c) => {
        const t = totals.get(c.key);
        return t == null ? '' : t.toFixed(2);
      }),
    ]);
    const filename = `consolidado_${(company?.name ?? 'export').replace(/\s/g, '_').toLowerCase()}.csv`;
    downloadCSV(filename, headers, rows);
  };

  // ─── Render ────────────────────────────────────────────────────────────

  if (!canAccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
        <p className="text-muted-foreground">Sin acceso al módulo Consolidado</p>
        <Link
          href="/"
          className="text-sm underline text-primary hover:text-primary/80"
        >
          Volver al inicio
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Consolidados"
        subtitle="Indicadores financieros mes a mes, columnas y meses ocultables, total final automático."
        icon={Table}
        actions={
          <>
            <button
              onClick={() => setShowSettings((s) => !s)}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
              title="Mostrar / ocultar columnas y meses"
            >
              {showSettings ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              <span className="hidden sm:inline">Columnas y meses</span>
            </button>
            <button
              onClick={handleExportCsv}
              className="inline-flex items-center gap-2 h-9 px-3 rounded-lg border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
              title="Exportar CSV con columnas/meses visibles"
            >
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">CSV</span>
            </button>
          </>
        }
      />

      {/* Settings panel — columnas + meses */}
      {showSettings && (
        <Card className="p-4 space-y-4">
          <section>
            <h3 className="text-sm font-semibold mb-2">Columnas</h3>
            <div className="flex flex-wrap gap-2">
              {columns.map((c) => {
                const isHidden = hiddenCols.has(c.key);
                return (
                  <button
                    key={c.key}
                    onClick={() => toggleCol(c.key)}
                    className={
                      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ' +
                      (isHidden
                        ? 'border-border bg-muted text-muted-foreground hover:bg-muted/60'
                        : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300 hover:bg-emerald-100/60')
                    }
                  >
                    {isHidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    {c.label}
                  </button>
                );
              })}
            </div>
          </section>
          <section>
            <h3 className="text-sm font-semibold mb-2">Meses</h3>
            <div className="flex flex-wrap gap-2">
              {periodContexts.map((ctx) => {
                const isHidden = hiddenMonths.has(ctx.periodId);
                return (
                  <button
                    key={ctx.periodId}
                    onClick={() => toggleMonth(ctx.periodId)}
                    className={
                      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ' +
                      (isHidden
                        ? 'border-border bg-muted text-muted-foreground hover:bg-muted/60'
                        : 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300 hover:bg-sky-100/60')
                    }
                  >
                    {isHidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    {ctx.periodLabel}
                  </button>
                );
              })}
            </div>
          </section>
        </Card>
      )}

      {/* Main table */}
      <Card className="p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="bg-muted/50 sticky top-0">
              <tr>
                <th className="text-left py-2.5 px-3 font-semibold sticky left-0 bg-muted/50 z-10 border-r border-border whitespace-nowrap">
                  Mes
                </th>
                {visibleColumns.map((c) => (
                  <th
                    key={c.key}
                    className="text-right py-2.5 px-3 font-semibold whitespace-nowrap"
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visiblePeriodContexts.length === 0 && (
                <tr>
                  <td
                    colSpan={visibleColumns.length + 1}
                    className="py-8 text-center text-muted-foreground"
                  >
                    Sin meses visibles. Activa al menos uno desde el panel de
                    &quot;Columnas y meses&quot;.
                  </td>
                </tr>
              )}
              {visiblePeriodContexts.map((ctx) => (
                <tr
                  key={ctx.periodId}
                  className="border-b border-border/50 hover:bg-muted/30"
                >
                  <td className="py-2 px-3 font-medium sticky left-0 bg-background hover:bg-muted/30 border-r border-border whitespace-nowrap">
                    {ctx.periodLabel}
                  </td>
                  {visibleColumns.map((c) => {
                    const value = c.compute(ctx);
                    const className =
                      c.kind === 'pos' && value > 0
                        ? 'text-emerald-600'
                        : c.kind === 'neg' && value > 0
                        ? 'text-red-600'
                        : '';
                    return (
                      <td
                        key={c.key}
                        className={`py-2 px-3 text-right tabular-nums whitespace-nowrap ${className}`}
                      >
                        {formatCurrency(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {visiblePeriodContexts.length > 0 && (
              <tfoot className="bg-muted/40">
                <tr className="font-semibold border-t-2 border-border">
                  <td className="py-2.5 px-3 sticky left-0 bg-muted/40 border-r border-border whitespace-nowrap">
                    Total
                  </td>
                  {visibleColumns.map((c) => {
                    const t = totals.get(c.key);
                    return (
                      <td
                        key={c.key}
                        className="py-2.5 px-3 text-right tabular-nums whitespace-nowrap"
                      >
                        {t == null ? '—' : formatCurrency(t)}
                        {c.total === 'last' && (
                          <span className="block text-[10px] font-normal text-muted-foreground">
                            (último mes)
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      <p className="text-xs text-muted-foreground">
        El total al pie suma los meses visibles. Para columnas como
        &quot;Reserva Acumulada&quot; usamos el valor del último mes visible
        (no la suma) porque acumula período tras período.
      </p>
    </div>
  );
}
