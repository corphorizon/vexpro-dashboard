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
 *
 * «Libro mayor» (2026-10-12)
 *   - El `catch` que dejaba el aporte de la API en 0 («Silent — fallback es
 *     0») ahora deja `null`: celda y total «—» en los meses derivados, KPI
 *     sin dato y un Notice `bad`. El porqué y lo descartado están en
 *     consolidado-model.ts, con test. Mismo arreglo que Balances.
 *   - Tabla → `FinTable` (cabecera sticky, montos tabulares, pie con doble
 *     raya); en móvil cada mes es una tarjeta con el resultado y, debajo,
 *     depósito neto y monto a distribuir.
 *   - Franja `KpiStrip` con los totales de los meses visibles (los mismos
 *     del pie, para las columnas clave aunque estén ocultas en la tabla).
 *   - Color = significado: depósitos y egresos ya no se pintan de verde /
 *     rojo por ser positivos (toda la columna lo es); el resultado del mes
 *     sí lleva signo de color (`sign`), porque ahí el signo es la noticia.
 *   - Toggles de columnas y meses → `Chip` (activo = visible).
 *   Medido antes/después en este archivo: 16 clases de paleta cruda
 *   (emerald/sky/red) + 6 `dark:` + 1 `text-[10px]` → 0; 26 tokens legados
 *   → 0. El CSV tiene las mismas columnas y valores; sólo cambia que una
 *   celda sin dato de la API sale vacía en vez de con el manual solo.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronUp, Download, Eye, EyeOff, Table } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { Notice } from '@/components/ui/notice';
import { KpiStrip, type KpiItem } from '@/components/ui/kpi-strip';
import { FinTable, type FinColumn } from '@/components/ui/fin-table';
import { Money, type MoneyTone } from '@/components/ui/money';
import { Chip } from '@/components/ui/chip';
import { ActionButton } from '@/components/ui/action-button';
import { useData } from '@/lib/data-context';
import { useAuth } from '@/lib/auth-context';
import { blockedConsolidatedColumns } from '@/lib/business-model';
import { hasModuleAccess } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/money';
import { downloadCSV } from '@/lib/csv-export';
import { apiFetch } from '@/lib/api-fetch';
import { isDerivedBrokerPeriod } from '@/lib/broker-logic';
import {
  apiForMonth,
  columnTotal,
  csvAmount,
  monthsMissingApi,
  rowMoney,
  type ApiMonthTotals,
  type ApiTotalsState,
  type TotalRule,
} from './consolidado-model';

// Column definition. `compute` recibe los helpers del DataProvider + el
// período y devuelve un número, o `null` si no lo sabemos (mes derivado sin
// dato de la API). `tone` decide el color con la regla de Money. `total`
// define cómo se agrega en el pie de tabla — la mayoría es suma directa,
// algunos campos (reserva acumulada) son el último valor visible.
interface PeriodRowContext {
  periodId: string;
  periodLabel: string;
  // datos pre-calculados para evitar repetir el getPeriodSummary
  summary: ReturnType<ReturnType<typeof useData>['getPeriodSummary']>;
  saldoInfo: {
    reservaPeriodo: number; reservaAcumulada: number; montoDistribuir: number;
    // egresosNetos: la cadena YA lo expone. La interfaz lo omitía, así que la
    // columna "Egresos Operativos" tenía que caer en summary.totalExpenses
    // (VIVO) mientras "Resultado del Mes" salía de la cadena (congelado en un
    // mes cerrado): con deriva, la fila no restaba bien.
    ingresosNetos: number; egresosNetos: number; saldoAFavor: number;
  } | null;
  // API totales del mes (Coinsbuy + FairPay + UniPayment). Llenado desde
  // /api/integrations/period-totals, que cuenta SOLO las wallets pineadas
  // OPERATIVAS (migración 084: las internas suman al balance pero no son
  // depósitos ni retiros de clientes).
  // Sumado a `summary.totalDeposits` (manual) para mostrar el monto real.
  // Antes la tabla solo leía manuales y Mayo/Junio aparecían como $0.
  // `null` = la API todavía no respondió o falló: NO es 0.
  apiDeposits: number | null;
  apiWithdrawals: number | null;
  /**
   * ¿El mes se rige por la regla «broker derivado de la API» (Abr 2026+)?
   * Ver src/lib/broker-logic.ts. Un mes HISTÓRICO no suma la API: sus totales
   * ya se cargaron a mano y sumarlos otra vez es contar dos veces.
   */
  isDerived: boolean;
}

interface ColumnDef {
  key: string;
  labelKey: string;
  compute: (ctx: PeriodRowContext) => number | null;
  total: TotalRule;
  tone: MoneyTone;
}

const STORAGE_HIDDEN_COLS = 'fd_consolidado_hidden_cols';
const STORAGE_HIDDEN_MONTHS = 'fd_consolidado_hidden_months';

/** Columnas que dependen del aporte de la API en los meses derivados. */
const API_COLUMNS = new Set(['totalDeposits', 'totalWithdrawals', 'netDeposit']);

/** KPIs de la franja, en orden; el primero es el hero. Se filtran por modelo de negocio. */
const KPI_COLUMNS = ['monthResult', 'operatingIncome', 'operatingExpenses', 'netDeposit', 'montoDistribuir'];

/** En la tarjeta móvil: la cifra a la derecha y las dos de apoyo debajo del mes. */
const MOBILE_PRIMARY = ['monthResult', 'netDeposit', 'montoDistribuir'];
const MOBILE_META = ['netDeposit', 'montoDistribuir'];

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

const pad2 = (n: number) => String(n).padStart(2, '0');

export default function ConsolidadoPage() {
  const {
    company,
    periods,
    getPeriodSummary,
    computeSaldoChain,
    getSnapshotDrifts,
    isPeriodAfterSaldoStart,
  } = useData();
  const { user } = useAuth();
  const { t } = useI18n();

  // Module gate: aprovecha el de "reports" porque la página vive bajo
  // /finanzas (mismo cluster ejecutivo). Si la empresa no tiene reports
  // habilitado, redirigimos al inicio.
  const canAccess = hasModuleAccess(user, 'reports', company?.active_modules ?? null, company?.business_model);

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

  // Deriva vivo-vs-congelado: alguien editó datos de un mes CERRADO. Toda esta
  // tabla muestra lo congelado (la cadena manda), así que sin este aviso la
  // edición pasaba desapercibida. Mismo aviso que /socios — la detección vive
  // en getSnapshotDrifts (data-context → applySnapshotOverrides), acá solo se
  // renderiza.
  const snapshotDrifts = useMemo(() => getSnapshotDrifts(), [getSnapshotDrifts]);
  const driftPeriodCount = useMemo(
    () => new Set(snapshotDrifts.map((d) => d.periodLabel)).size,
    [snapshotDrifts],
  );

  // ─── API totales por período ─────────────────────────────────────────────
  //
  // /api/integrations/period-totals devuelve un objeto
  // `months: { '2026-04': { deposits, withdrawals } }` aplicando el filtrado
  // por wallets pineadas OPERATIVAS (RPC get_period_totals_by_month, ver
  // migración 084). Lo cargamos una sola vez
  // (al cambiar de empresa) y lo guardamos en estado para que cada fila
  // de la tabla sume API + manual.
  //
  // El rango pedido es la clave de la respuesta: una respuesta de otra
  // empresa / otro rango no cuenta, y mientras la del rango actual no llega
  // el estado es «cargando» (derivado, sin setState síncrono en el efecto).
  const apiRange = useMemo(() => {
    if (!company || periods.length === 0) return null;
    const sorted = [...periods].sort((a, b) =>
      a.year !== b.year ? a.year - b.year : a.month - b.month,
    );
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const lastDay = new Date(last.year, last.month, 0).getDate();
    const from = `${first.year}-${pad2(first.month)}-01`;
    const to = `${last.year}-${pad2(last.month)}-${pad2(lastDay)}`;
    return { key: `${company.id}:${from}:${to}`, from, to };
  }, [company, periods]);

  const [apiResult, setApiResult] = useState<
    { key: string; ok: true; months: Record<string, ApiMonthTotals> } | { key: string; ok: false } | null
  >(null);

  useEffect(() => {
    if (!apiRange) return;
    const controller = new AbortController();
    (async () => {
      try {
        // apiFetch, no `fetch` pelado (§4.2 del manual): además del scope de
        // superadmin viewing-as —que el `withActiveCompany` suelto ya cubría—
        // trae el timeout propio, así que un endpoint colgado no deja la tabla
        // esperando para siempre. El `signal` explícito gana sobre el interno
        // para que el cleanup del efecto siga cancelando al cambiar de empresa.
        const res = await apiFetch(
          `/api/integrations/period-totals?from=${apiRange.from}&to=${apiRange.to}`,
          { signal: controller.signal },
        );
        const json = await res.json();
        if (controller.signal.aborted) return;
        if (json?.success && json.months) {
          setApiResult({ key: apiRange.key, ok: true, months: json.months });
        } else {
          setApiResult({ key: apiRange.key, ok: false });
        }
      } catch {
        // Ya NO es silencioso: sin el aporte de la API, los meses derivados
        // no tienen número (consolidado-model.ts). Un abort por cambio de
        // empresa no es un fallo.
        if (!controller.signal.aborted) setApiResult({ key: apiRange.key, ok: false });
      }
    })();
    return () => controller.abort();
  }, [apiRange]);

  const apiState: ApiTotalsState = useMemo(() => {
    if (!apiRange) return { status: 'ok', months: {} };
    if (!apiResult || apiResult.key !== apiRange.key) return { status: 'loading' };
    return apiResult.ok ? { status: 'ok', months: apiResult.months } : { status: 'failed' };
  }, [apiRange, apiResult]);

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
            ingresosNetos: saldoEntry.ingresosNetos,
            egresosNetos: saldoEntry.egresosNetos,
            saldoAFavor: saldoEntry.saldoAFavor,
          }
        : null;
      const key = `${p.year}-${pad2(p.month)}`;
      const api = apiForMonth(apiState, key);
      return {
        periodId: p.id,
        periodLabel: p.label ?? key,
        summary,
        saldoInfo,
        apiDeposits: api.deposits,
        apiWithdrawals: api.withdrawals,
        isDerived: isDerivedBrokerPeriod({ year: p.year, month: p.month }),
      };
    });
  }, [periods, getPeriodSummary, saldoChain, apiState]);

  // Definición de columnas. Orden = orden de aparición en la tabla.
  const columns: ColumnDef[] = useMemo(
    () => [
      {
        key: 'totalDeposits',
        labelKey: 'consolidated.colDeposits',
        // Fórmula ÚNICA (broker-logic.ts) vía `rowMoney`: API + manual en los
        // meses derivados (Abr 2026+), sólo manual en los históricos.
        compute: (c) => rowMoney(c).totalDeposits,
        total: 'sum',
        tone: 'auto',
      },
      {
        key: 'totalWithdrawals',
        labelKey: 'consolidated.colWithdrawals',
        compute: (c) => rowMoney(c).totalWithdrawals,
        total: 'sum',
        tone: 'auto',
      },
      {
        key: 'netDeposit',
        labelKey: 'consolidated.colNetDeposit',
        compute: (c) => rowMoney(c).netDeposit,
        total: 'sum',
        tone: 'auto',
      },
      // ── Desglose de ingresos: VALOR VIVO, a diferencia de las columnas de
      //    abajo (auditoría 2026-08, B4).
      //
      // `operatingIncome` y `monthResult` salen de la cadena (saldoInfo), que
      // para un período CERRADO devuelve los insumos congelados en el
      // snapshot. Estas tres columnas salen de getPeriodSummary, o sea de las
      // tablas vivas: si alguien edita un mes cerrado, el desglose se mueve y
      // el total de la derecha no. No se corrige leyéndolas de la cadena
      // porque PeriodDistResult NO expone el desglose — solo ingresosNetos /
      // egresosNetos / saldoAFavor (ver src/lib/distribution.ts). Exponerlo es
      // un cambio en la fórmula canónica y en el formato del snapshot, fuera
      // del alcance de este fix. Hasta entonces, se leen como "así están hoy
      // las tablas", no como "así cerró el mes".
      {
        key: 'brokerPnl',
        labelKey: 'summary.brokerPnl',
        compute: (c) => c.summary?.operatingIncome?.broker_pnl ?? 0,
        total: 'sum',
        tone: 'auto',
      },
      {
        key: 'propFirmNet',
        labelKey: 'consolidated.colPropFirmBalance',
        compute: (c) => c.summary?.propFirmNetIncome ?? 0,
        total: 'sum',
        tone: 'auto',
      },
      {
        key: 'investmentProfits',
        labelKey: 'consolidated.colInvestmentProfits',
        compute: (c) => c.summary?.investmentProfits ?? 0,
        total: 'sum',
        tone: 'auto',
      },
      {
        key: 'operatingIncome',
        labelKey: 'consolidated.colOperatingIncome',
        compute: (c) => c.saldoInfo?.ingresosNetos ?? 0,
        total: 'sum',
        tone: 'auto',
      },
      {
        key: 'monthResult',
        labelKey: 'consolidated.colMonthResult',
        compute: (c) => c.saldoInfo?.saldoAFavor ?? 0,
        total: 'sum',
        // El resultado del mes es donde el signo ES la noticia.
        tone: 'sign',
      },
      {
        key: 'operatingExpenses',
        labelKey: 'consolidated.colOperatingExpenses',
        // De la CADENA, no de las tablas vivas: es el mismo egreso que
        // "Resultado del Mes" resta a "Ingresos Operativos". Fallback al vivo
        // solo si el período no está en la cadena (no debería pasar).
        compute: (c) => c.saldoInfo?.egresosNetos ?? c.summary?.totalExpenses ?? 0,
        total: 'sum',
        tone: 'auto',
      },
      {
        key: 'reservaPeriodo',
        labelKey: 'consolidated.colPeriodReserve',
        // La cadena YA calculó la reserva con el % real de cada período. Acá
        // se recalculaba con 10% fijo y el "monto a distribuir" con ×0,9:
        // para Vex Pro y AP Markets coincidía de casualidad (usan 10%), pero
        // Horizon tiene meses al 15%, 50%, 12,31%, 11,74% y 0% — esas cifras
        // salían falsas. Una segunda fórmula que diverge de la real es el modo
        // de falla número uno de este repo.
        compute: (c) => {
          if (!c.summary) return 0;
          if (!isPeriodAfterSaldoStart(c.periodId)) return 0;
          return c.saldoInfo?.reservaPeriodo ?? 0;
        },
        total: 'sum',
        tone: 'auto',
      },
      {
        key: 'reservaAcumulada',
        labelKey: 'consolidated.colAccumulatedReserve',
        compute: (c) => c.saldoInfo?.reservaAcumulada ?? 0,
        total: 'last',
        tone: 'auto',
      },
      {
        key: 'montoDistribuir',
        labelKey: 'consolidated.colAmountToDistribute',
        // montoDistribuir ya viene NETO de reserva desde la cadena; el ×0,9
        // le descontaba un 10% por segunda vez.
        compute: (c) => c.saldoInfo?.montoDistribuir ?? 0,
        total: 'sum',
        tone: 'auto',
      },
      {
        key: 'p2p',
        labelKey: 'consolidated.colP2pTransfer',
        compute: (c) => c.summary?.p2pTransfer ?? 0,
        total: 'sum',
        tone: 'auto',
      },
      {
        key: 'propFirmSales',
        labelKey: 'consolidated.colPropFirmSales',
        compute: (c) => c.summary?.propFirmSales ?? 0,
        total: 'sum',
        tone: 'auto',
      },
      {
        key: 'expensesPaid',
        labelKey: 'consolidated.colExpensesPaid',
        compute: (c) => c.summary?.totalExpensesPaid ?? 0,
        total: 'sum',
        tone: 'auto',
      },
      {
        key: 'expensesPending',
        labelKey: 'consolidated.colExpensesPending',
        compute: (c) => c.summary?.totalExpensesPending ?? 0,
        total: 'sum',
        tone: 'auto',
      },
    ],
    [isPeriodAfterSaldoStart],
  );

  // Las columnas que el modelo de negocio no contempla se van antes que el
  // filtro manual: no tiene sentido ofrecer "Net Deposit" en el selector de
  // una consultora que no tiene depósitos.
  const modelColumns = useMemo(() => {
    const blocked = new Set(blockedConsolidatedColumns(company?.business_model));
    return columns.filter((c) => !blocked.has(c.key));
  }, [columns, company?.business_model]);

  const visibleColumns = useMemo(
    () => modelColumns.filter((c) => !hiddenCols.has(c.key)),
    [modelColumns, hiddenCols],
  );
  const visiblePeriodContexts = useMemo(
    () => periodContexts.filter((c) => !hiddenMonths.has(c.periodId)),
    [periodContexts, hiddenMonths],
  );

  // Total por columna del modelo (con regla de agregación) sobre los meses
  // visibles. La tabla muestra los de las columnas visibles; la franja de
  // KPIs, los de sus columnas clave aunque estén ocultas en la tabla.
  const totals = useMemo(() => {
    const result = new Map<string, number | null>();
    for (const col of modelColumns) {
      const v = columnTotal(visiblePeriodContexts.map((ctx) => col.compute(ctx)), col.total);
      if (v !== undefined) result.set(col.key, v);
    }
    return result;
  }, [modelColumns, visiblePeriodContexts]);

  // ¿El aporte de la API falta en algún mes visible, para alguna columna que
  // el modelo muestra? Si el modelo no tiene depósitos/retiros, no importa.
  const usesApi = modelColumns.some((c) => API_COLUMNS.has(c.key));
  const missingApiMonths = usesApi ? monthsMissingApi(visiblePeriodContexts) : 0;

  const handleExportCsv = () => {
    const headers = [t('consolidated.month'), ...visibleColumns.map((c) => t(c.labelKey))];
    const rows = visiblePeriodContexts.map((ctx) => [
      ctx.periodLabel,
      ...visibleColumns.map((c) => csvAmount(c.compute(ctx))),
    ]);
    rows.push([
      'TOTAL',
      ...visibleColumns.map((c) => csvAmount(totals.get(c.key))),
    ]);
    const filename = `consolidado_${(company?.name ?? 'export').replace(/\s/g, '_').toLowerCase()}.csv`;
    downloadCSV(filename, headers, rows);
  };

  // ─── Render ────────────────────────────────────────────────────────────

  if (!canAccess) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
        <p className="text-text-2">{t('consolidated.noAccess')}</p>
        <Link href="/" className="text-[13px] text-brand-ink underline underline-offset-2">
          {t('consolidated.backHome')}
        </Link>
      </div>
    );
  }

  const monthsSub = t('consolidated.lm.monthsShown', {
    shown: String(visiblePeriodContexts.length),
    total: String(periodContexts.length),
  });
  const apiMissingBadge =
    apiState.status === 'loading'
      ? { kind: 'stale' as const, label: t('consolidated.lm.apiLoading') }
      : { kind: 'bad' as const, label: t('consolidated.lm.apiMissingBadge') };

  const kpis: KpiItem[] = KPI_COLUMNS.flatMap((key, i) => {
    const col = modelColumns.find((c) => c.key === key);
    if (!col) return [];
    const value = totals.get(key) ?? null;
    return [
      {
        key,
        label: t(col.labelKey),
        value,
        format: 'money' as const,
        tone: col.tone,
        hero: i === 0,
        sub: value === null && API_COLUMNS.has(key) ? undefined : monthsSub,
        missingBadge: API_COLUMNS.has(key) ? apiMissingBadge : undefined,
      },
    ];
  });

  // Móvil: la cifra de la derecha es la primera visible de MOBILE_PRIMARY;
  // el resto de las columnas se ve en escritorio (o rotando el teléfono).
  const mobilePrimary = MOBILE_PRIMARY.find((k) => visibleColumns.some((c) => c.key === k)) ?? visibleColumns[0]?.key;
  const mobileMetaCols = visibleColumns.filter((c) => MOBILE_META.includes(c.key) && c.key !== mobilePrimary);

  const tableColumns: FinColumn<PeriodRowContext>[] = [
    {
      key: 'month',
      header: t('consolidated.month'),
      cell: (ctx) => ctx.periodLabel,
      mobileMeta: mobileMetaCols.length
        ? (ctx) =>
            mobileMetaCols.map((c) => (
              <span key={c.key} className="inline-flex items-center gap-1">
                {t(c.labelKey)}
                <Money value={c.compute(ctx)} tone={c.tone} nullLabel={t('ui.noData')} />
              </span>
            ))
        : undefined,
    },
    ...visibleColumns.map<FinColumn<PeriodRowContext>>((c) => ({
      key: c.key,
      header: t(c.labelKey),
      kind: 'money',
      value: (ctx) => c.compute(ctx),
      money: { tone: c.tone },
      hideSm: c.key !== mobilePrimary,
    })),
  ];

  const footerValues: Record<string, number | null> = {};
  for (const c of visibleColumns) {
    if (totals.has(c.key)) footerValues[c.key] = totals.get(c.key) ?? null;
  }
  const lastCols = visibleColumns.filter((c) => c.total === 'last');

  const settingsButtonLabel = t('consolidated.columnsAndMonths');

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('consolidated.title')}
        subtitle={t('consolidated.subtitle')}
        icon={Table}
        actions={
          <>
            <ActionButton
              onClick={() => setShowSettings((s) => !s)}
              title={t('consolidated.toggleTitle')}
              aria-label={settingsButtonLabel}
              aria-expanded={showSettings}
            >
              {showSettings ? (
                <ChevronUp aria-hidden className="size-[15px]" strokeWidth={1.75} />
              ) : (
                <ChevronDown aria-hidden className="size-[15px]" strokeWidth={1.75} />
              )}
              <span className="max-sm:hidden">{settingsButtonLabel}</span>
            </ActionButton>
            <ActionButton onClick={handleExportCsv} title={t('consolidated.exportCsvTitle')} aria-label={t('common.csv')}>
              <Download aria-hidden className="size-[15px]" strokeWidth={1.75} />
              <span className="max-sm:hidden">{t('common.csv')}</span>
            </ActionButton>
          </>
        }
      />

      {kpis.length > 0 && <KpiStrip items={kpis} />}

      {/* Aporte de la API sin dato: los meses derivados muestran «—» y los
          totales que los incluyen también. Antes: catch silencioso → 0. */}
      {apiState.status === 'failed' && missingApiMonths > 0 && (
        <Notice kind="bad" title={t('consolidated.lm.apiFailedTitle')}>
          {t('consolidated.lm.apiFailedBody', { count: String(missingApiMonths) })}
        </Notice>
      )}

      {/* Deriva snapshot-vs-vivo — mismo aviso que /socios */}
      {snapshotDrifts.length > 0 && (
        <Notice
          kind="bad"
          title={t('consolidated.driftTitle', {
            count: String(driftPeriodCount),
            periods: driftPeriodCount === 1
              ? t('consolidated.driftPeriodOne')
              : t('consolidated.driftPeriodMany'),
          })}
        >
          <ul className="mt-1 space-y-0.5 text-[12px]">
            {snapshotDrifts.slice(0, 6).map((d, i) => (
              <li key={i}>
                {t('consolidated.driftRow', {
                  period: d.periodLabel,
                  field: d.field,
                  frozen: formatMoney(d.frozen),
                  live: formatMoney(d.live),
                })}
              </li>
            ))}
            {snapshotDrifts.length > 6 && (
              <li>{t('consolidated.driftMore', { count: String(snapshotDrifts.length - 6) })}</li>
            )}
          </ul>
          <p className="mt-1 text-[12px]">{t('consolidated.driftHint')}</p>
        </Notice>
      )}

      {/* Settings panel — columnas + meses. Chip activo = se ve. */}
      {showSettings && (
        <Panel title={settingsButtonLabel} bodyClassName="space-y-4">
          <section>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[.03em] text-text-3">
              {t('consolidated.columns')}
            </h3>
            <div className="flex flex-wrap gap-2">
              {modelColumns.map((c) => {
                const isHidden = hiddenCols.has(c.key);
                return (
                  <Chip
                    key={c.key}
                    active={!isHidden}
                    icon={isHidden ? EyeOff : Eye}
                    onClick={() => toggleCol(c.key)}
                  >
                    {t(c.labelKey)}
                  </Chip>
                );
              })}
            </div>
          </section>
          <section>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[.03em] text-text-3">
              {t('consolidated.months')}
            </h3>
            <div className="flex flex-wrap gap-2">
              {periodContexts.map((ctx) => {
                const isHidden = hiddenMonths.has(ctx.periodId);
                return (
                  <Chip
                    key={ctx.periodId}
                    active={!isHidden}
                    icon={isHidden ? EyeOff : Eye}
                    onClick={() => toggleMonth(ctx.periodId)}
                  >
                    {ctx.periodLabel}
                  </Chip>
                );
              })}
            </div>
          </section>
        </Panel>
      )}

      {/* Main table */}
      <Panel
        flush
        title={t('consolidated.lm.tableTitle')}
        hint={monthsSub}
        footer={
          <div className="space-y-1">
            <p>{t('consolidated.footerNote')}</p>
            {lastCols.length > 0 && (
              <p>
                {lastCols.map((c) => t(c.labelKey)).join(', ')} {t('consolidated.lastMonthNote')}
              </p>
            )}
          </div>
        }
      >
        <FinTable
          columns={tableColumns}
          rows={visiblePeriodContexts}
          rowKey={(ctx) => ctx.periodId}
          caption={t('consolidated.title')}
          empty={t('consolidated.noVisibleMonths')}
          maxHeight="70vh"
          footer={
            visiblePeriodContexts.length > 0
              ? {
                  label: t('consolidated.lm.totalMonths', { count: String(visiblePeriodContexts.length) }),
                  values: footerValues,
                }
              : undefined
          }
        />
      </Panel>
    </div>
  );
}
